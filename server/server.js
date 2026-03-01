const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const TUNNEL_SECRET = process.env.TUNNEL_SECRET;
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const WS_CONNECT_TIMEOUT_MS = 10_000;
const MAX_WS_CONNECTIONS_PER_TUNNEL = 50;
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

if (!TUNNEL_SECRET) {
    console.error('FATAL: TUNNEL_SECRET environment variable is required');
    process.exit(1);
}

const tunnels = new Map();         // subdomain  → WebSocket
const pendingRequests = new Map(); // requestId  → { res, timer, subdomain }
const tunnelRequests = new Map();  // subdomain  → Set<requestId>
const publicWebSockets = new Map(); // connectionId → { publicWs, subdomain, buffer, pending, timeout }
const tunnelWebSockets = new Map(); // subdomain → Set<connectionId>

function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function generateSubdomain() {
    let sub;
    do { sub = crypto.randomBytes(4).toString('hex'); }
    while (tunnels.has(sub));
    return sub;
}

function handleWebSocketUpgrade(req, socket, head, wssPublic) {
    const subdomain = req.headers.host?.split('.')[0];
    const tunnelWs = tunnels.get(subdomain);

    if (!tunnelWs || tunnelWs.readyState !== WebSocket.OPEN) {
        socket.destroy();
        return;
    }

    const connSet = tunnelWebSockets.get(subdomain);
    if (connSet && connSet.size >= MAX_WS_CONNECTIONS_PER_TUNNEL) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nToo many WebSocket connections');
        socket.destroy();
        return;
    }

    const connectionId = crypto.randomUUID();
    console.log(`[ws] connectionId=${connectionId} upgrade request for ${subdomain}${req.url}`);

    wssPublic.handleUpgrade(req, socket, head, (publicWs) => {
        const entry = {
            publicWs,
            subdomain,
            buffer: [],
            pending: true,
            timeout: setTimeout(() => {
                entry.timeout = null;
                entry.pending = false;
                try {
                    publicWs.close(1011, 'Local connection timeout');
                } catch {}
                publicWebSockets.delete(connectionId);
                tunnelWebSockets.get(subdomain)?.delete(connectionId);
                try {
                    tunnelWs.send(JSON.stringify({ type: 'ws-close', connectionId, code: 1011, reason: 'Timeout' }));
                } catch {}
                console.log(`[ws] connectionId=${connectionId} timeout`);
            }, WS_CONNECT_TIMEOUT_MS)
        };
        publicWebSockets.set(connectionId, entry);
        tunnelWebSockets.get(subdomain)?.add(connectionId);

        publicWs.on('message', (data, isBinary) => {
            const e = publicWebSockets.get(connectionId);
            if (!e) return;
            const payload = {
                type: 'ws-frame',
                connectionId,
                isBinary: !!isBinary,
                data: (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('base64')
            };
            if (e.pending) {
                e.buffer.push({ isBinary: !!isBinary, data: payload.data });
            } else {
                try {
                    tunnelWs.send(JSON.stringify(payload));
                } catch (err) {
                    try { publicWs.close(1011, 'Tunnel send failed'); } catch {}
                }
            }
        });

        publicWs.on('close', (code, reason) => {
            try {
                tunnelWs.send(JSON.stringify({
                    type: 'ws-close',
                    connectionId,
                    code,
                    reason: (reason && reason.toString) ? reason.toString() : (reason || '')
                }));
            } catch {}
            const e = publicWebSockets.get(connectionId);
            if (e) clearTimeout(e.timeout);
            publicWebSockets.delete(connectionId);
            tunnelWebSockets.get(subdomain)?.delete(connectionId);
            console.log(`[ws] connectionId=${connectionId} closed by public client (code=${code})`);
        });

        try {
            tunnelWs.send(JSON.stringify({
                type: 'ws-connect',
                connectionId,
                path: req.url,
                headers: req.headers
            }));
        } catch (err) {
            clearTimeout(entry.timeout);
            try { publicWs.close(1011, 'Tunnel send failed'); } catch {}
            publicWebSockets.delete(connectionId);
            tunnelWebSockets.get(subdomain)?.delete(connectionId);
        }
    });
}

// --- Control port (4001): Accept and authenticate tunnel clients ---
const controlServer = new WebSocket.Server({ port: 4001, maxPayload: 16 * 1024 * 1024 });

controlServer.on('connection', (ws) => {
    let authenticated = false;
    let subdomain = null;

    const authTimeout = setTimeout(() => {
        if (!authenticated) ws.close(1008, 'Authentication timeout');
    }, 5000);

    ws.on('message', (data) => {
        if (!authenticated) clearTimeout(authTimeout);

        let msg;
        try { msg = JSON.parse(data); }
        catch { ws.close(1003, 'Invalid message format'); return; }

        if (!authenticated) {
            if (msg.type !== 'auth' || !constantTimeEqual(msg.token, TUNNEL_SECRET)) {
                ws.close(1008, 'Unauthorized');
                return;
            }

            const requested = msg.subdomain;
            if (requested !== undefined) {
                if (!SUBDOMAIN_REGEX.test(requested)) {
                    ws.close(1008, `Invalid subdomain name. Must match: ${SUBDOMAIN_REGEX}`);
                    return;
                }
                if (tunnels.has(requested)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Subdomain '${requested}' is already in use. Choose a different name or omit --subdomain for a random one.`
                    }));
                    ws.close(1008, `Subdomain '${requested}' is already in use`);
                    return;
                }
                subdomain = requested;
            } else {
                subdomain = generateSubdomain();
            }

            authenticated = true;
            tunnels.set(subdomain, ws);
            tunnelRequests.set(subdomain, new Set());
            tunnelWebSockets.set(subdomain, new Set());

            ws.send(JSON.stringify({ type: 'registered', subdomain }));
            console.log(`[+] Tunnel registered: ${subdomain}`);

            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            const heartbeat = setInterval(() => {
                if (!ws.isAlive) {
                    console.log(`[-] Ghost connection dropped: ${subdomain}`);
                    clearInterval(heartbeat);
                    ws.terminate();
                    return;
                }
                ws.isAlive = false;
                ws.ping();
            }, HEARTBEAT_INTERVAL_MS);

            ws.on('close', () => {
                clearInterval(heartbeat);
                tunnels.delete(subdomain);

                const reqIds = tunnelRequests.get(subdomain) || new Set();
                for (const requestId of reqIds) {
                    const pending = pendingRequests.get(requestId);
                    if (pending) {
                        clearTimeout(pending.timer);
                        if (!pending.res.headersSent) {
                            pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
                            pending.res.end('Tunnel client disconnected');
                        }
                        pendingRequests.delete(requestId);
                    }
                }
                tunnelRequests.delete(subdomain);

                const connIds = tunnelWebSockets.get(subdomain) || new Set();
                for (const connectionId of connIds) {
                    const entry = publicWebSockets.get(connectionId);
                    if (entry) {
                        clearTimeout(entry.timeout);
                        try {
                            if (entry.publicWs.readyState === WebSocket.OPEN || entry.publicWs.readyState === WebSocket.CLOSING) {
                                entry.publicWs.close(1011, 'Tunnel client disconnected');
                            }
                        } catch {}
                        publicWebSockets.delete(connectionId);
                    }
                }
                tunnelWebSockets.delete(subdomain);
                console.log(`[-] Tunnel closed: ${subdomain}`);
            });

            return;
        }

        if (msg.type === 'response') {
            const pending = pendingRequests.get(msg.requestId);
            if (!pending) return;

            clearTimeout(pending.timer);
            pendingRequests.delete(msg.requestId);
            tunnelRequests.get(subdomain)?.delete(msg.requestId);

            const decodedBody = Buffer.from(msg.body || '', 'base64');

            const headers = { ...msg.headers };
            delete headers['content-length'];
            delete headers['transfer-encoding'];

            if (msg.status === 204) {
                pending.res.writeHead(msg.status, headers);
                pending.res.end();
            } else {
                if (!headers['content-length']) {
                    headers['content-length'] = decodedBody.length;
                }
                pending.res.writeHead(msg.status, headers);
                pending.res.end(decodedBody);
            }
        }

        if (msg.type === 'ws-connect-response') {
            const entry = publicWebSockets.get(msg.connectionId);
            if (!entry) return;

            clearTimeout(entry.timeout);
            entry.timeout = null;
            entry.pending = false;

            if (msg.status === 101) {
                console.log(`[ws] connectionId=${msg.connectionId} established`);
                for (const frame of entry.buffer) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'ws-frame',
                            connectionId: msg.connectionId,
                            isBinary: frame.isBinary,
                            data: frame.data
                        }));
                    } catch (e) {
                        try { entry.publicWs.close(1011, 'Tunnel send failed'); } catch {}
                        break;
                    }
                }
                entry.buffer = [];
            } else {
                try {
                    entry.publicWs.close(1011, msg.body ? Buffer.from(msg.body, 'base64').toString() : 'Local server unavailable');
                } catch {}
                publicWebSockets.delete(msg.connectionId);
                tunnelWebSockets.get(subdomain)?.delete(msg.connectionId);
                console.log(`[ws] connectionId=${msg.connectionId} rejected (status=${msg.status})`);
            }
        }

        if (msg.type === 'ws-frame') {
            const entry = publicWebSockets.get(msg.connectionId);
            if (!entry) return;
            try {
                if (entry.publicWs.readyState === WebSocket.OPEN) {
                    const buf = Buffer.from(msg.data || '', 'base64');
                    entry.publicWs.send(buf, { binary: !!msg.isBinary });
                }
            } catch (e) {
                try {
                    ws.send(JSON.stringify({ type: 'ws-close', connectionId: msg.connectionId, code: 1011, reason: 'Send failed' }));
                } catch {}
                publicWebSockets.delete(msg.connectionId);
                tunnelWebSockets.get(subdomain)?.delete(msg.connectionId);
            }
        }

        if (msg.type === 'ws-close') {
            const entry = publicWebSockets.get(msg.connectionId);
            if (!entry) return;
            clearTimeout(entry.timeout);
            try {
                if (entry.publicWs.readyState === WebSocket.OPEN || entry.publicWs.readyState === WebSocket.CLOSING) {
                    entry.publicWs.close(msg.code || 1000, msg.reason || '');
                }
            } catch {}
            publicWebSockets.delete(msg.connectionId);
            tunnelWebSockets.get(subdomain)?.delete(msg.connectionId);
            console.log(`[ws] connectionId=${msg.connectionId} closed by client (code=${msg.code})`);
        }
    });
});

// --- Public port (4000): Proxy incoming HTTP traffic through the tunnel ---
const wssPublic = new WebSocket.Server({ noServer: true });

const publicServer = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');

    // Health check — short-circuit before subdomain lookup so it works
    // regardless of whether any tunnels are registered
    if (req.url === '/_tunnel_health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    const subdomain = req.headers.host?.split('.')[0];
    const ws = tunnels.get(subdomain);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Tunnel not found or not connected');
        return;
    }

    const requestId = crypto.randomUUID();
    const bodyChunks = [];
    let totalSize = 0;
    let aborted = false;

    console.log(`[→] ${req.method} ${subdomain} ${req.url}`);

    req.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_BYTES) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload too large (max 10MB)');
            req.destroy();
            return;
        }
        bodyChunks.push(chunk);
    });

    req.on('error', (err) => {
        console.error('Public request error:', err.message);
        if (!res.headersSent) {
            res.statusCode = 400;
            res.end();
        }
    });

    req.on('end', () => {
        if (aborted) return;

        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            tunnelRequests.get(subdomain)?.delete(requestId);
            if (res.headersSent) return;
            res.writeHead(504, { 'Content-Type': 'text/plain' });
            res.end('Gateway Timeout: local server did not respond in time');
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(requestId, { res, timer, subdomain });
        tunnelRequests.get(subdomain)?.add(requestId);

        try {
            ws.send(JSON.stringify({
                type: 'request',
                requestId,
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: Buffer.concat(bodyChunks).toString('base64')
            }));
        } catch (err) {
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            tunnelRequests.get(subdomain)?.delete(requestId);
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Tunnel connection lost');
        }
    });
});

publicServer.on('upgrade', (req, socket, head) => {
    if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
    }
    handleWebSocketUpgrade(req, socket, head, wssPublic);
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully...');

    for (const [requestId, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        if (!pending.res.headersSent) {
            try {
                pending.res.writeHead(503, {
                    'Content-Type': 'text/plain',
                    'Retry-After': '5'
                });
                pending.res.end('Service temporarily unavailable — server restarting');
            } catch {}
        }
        pendingRequests.delete(requestId);
    }

    for (const [connectionId, entry] of publicWebSockets) {
        clearTimeout(entry.timeout);
        try {
            if (entry.publicWs.readyState === WebSocket.OPEN || entry.publicWs.readyState === WebSocket.CLOSING) {
                entry.publicWs.close(1011, 'Server restarting');
            }
        } catch {}
        publicWebSockets.delete(connectionId);
    }
    for (const connSet of tunnelWebSockets.values()) {
        connSet.clear();
    }

    for (const [, ws] of tunnels) {
        try {
            ws.send(JSON.stringify({ type: 'shutdown', message: 'Server restarting, please reconnect' }));
        } catch {}
    }

    setTimeout(() => {
        publicServer.close();
        controlServer.close();
        process.exit(0);
    }, 2000);
});

process.on('SIGINT', () => process.emit('SIGTERM'));

publicServer.listen(4000, () => console.log('Public proxy listening on :4000'));
console.log('Control server listening on :4001 (via nginx /tunnel-control)');
