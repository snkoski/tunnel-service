// server.js — runs on VPS
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const TUNNEL_SECRET = process.env.TUNNEL_SECRET;
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

if (!TUNNEL_SECRET) {
    console.error('FATAL: TUNNEL_SECRET environment variable is required');
    process.exit(1);
}

const tunnels = new Map();         // subdomain  → WebSocket
const pendingRequests = new Map(); // requestId  → { res, timer, subdomain }
const tunnelRequests = new Map();  // subdomain  → Set<requestId>  (for cleanup on disconnect)

// Timing-safe token comparison — prevents timing attacks that could
// leak the secret by measuring how long the comparison takes
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

// --- Control port (4001): Accept and authenticate tunnel clients ---
// maxPayload: the ws default is 100MB. A misbehaving client could send
// an enormous payload and exhaust server memory. 16MB comfortably covers
// a 10MB response body after ~33% Base64 inflation, with headroom.
const controlServer = new WebSocket.Server({ port: 4001, maxPayload: 16 * 1024 * 1024 });

controlServer.on('connection', (ws) => {
    let authenticated = false;
    let subdomain = null;

    // Give the client 5 seconds to send the auth token as the first message.
    // This keeps the secret out of URLs, nginx logs, and shell history.
    const authTimeout = setTimeout(() => {
        if (!authenticated) ws.close(1008, 'Authentication timeout');
    }, 5000);

    ws.on('message', (data) => {
        // Always wrap JSON parsing — a malformed frame must not crash the server.
        // Clear the auth timeout first regardless of outcome — if parse fails,
        // we close with 1003 and the timeout firing 5s later on a closed socket
        // would be noisy and confusing.
        if (!authenticated) clearTimeout(authTimeout);

        let msg;
        try { msg = JSON.parse(data); }
        catch { ws.close(1003, 'Invalid message format'); return; }

        // --- First message must be the auth handshake ---
        if (!authenticated) {

            if (msg.type !== 'auth' || !constantTimeEqual(msg.token, TUNNEL_SECRET)) {
                ws.close(1008, 'Unauthorized');
                return;
            }

            // Validate and assign subdomain
            const requested = msg.subdomain;
            if (requested !== undefined) {
                if (!SUBDOMAIN_REGEX.test(requested)) {
                    ws.close(1008, `Invalid subdomain name. Must match: ${SUBDOMAIN_REGEX}`);
                    return;
                }
                if (tunnels.has(requested)) {
                    // Send a structured error so the CLI can display a useful message
                    // before the connection closes — "1008" alone tells the user nothing
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

            ws.send(JSON.stringify({ type: 'registered', subdomain }));
            console.log(`[+] Tunnel registered: ${subdomain}`);

            // Start heartbeat to detect ghost connections
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

                // Immediately 502 all in-flight requests for this tunnel.
                // Guard headersSent — the 413, req.on('error'), or timeout callback
                // may have already written headers to this response object.
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
                console.log(`[-] Tunnel closed: ${subdomain}`);
            });

            return;
        }

        // --- Subsequent messages are responses from the local client ---
        if (msg.type === 'response') {
            const pending = pendingRequests.get(msg.requestId);
            if (!pending) return; // already timed out

            clearTimeout(pending.timer);
            pendingRequests.delete(msg.requestId);
            tunnelRequests.get(subdomain)?.delete(msg.requestId);

            // Decode the body first so we can set Content-Length accurately.
            // Without this, Node sends chunked encoding, which causes some
            // clients (curl, certain browsers) to hang on abrupt closes.
            // Default to empty string — msg.body is absent on 204 No Content
            // and HEAD responses; Buffer.from(undefined) throws a TypeError.
            const decodedBody = Buffer.from(msg.body || '', 'base64');

            const headers = { ...msg.headers };
            delete headers['content-length'];
            // If the local app used chunked encoding, that header would still
            // be present here. Having both Transfer-Encoding: chunked AND a
            // Content-Length in the same response is malformed HTTP — nginx
            // treats it as a 502. Strip it; we're sending a complete buffer.
            delete headers['transfer-encoding'];
            // 204 No Content: RFC 7230 forbids a Content-Length header.
            // HEAD: the client preserved the original Content-Length (reflecting
            //   what a GET would return), so don't overwrite it with the decoded
            //   buffer length (which would be 0 for a body-less HEAD response).
            // Everything else: compute Content-Length from the actual decoded buffer.
            if (msg.status === 204) {
                pending.res.writeHead(msg.status, headers);
                pending.res.end();
            } else {
                if (!headers['content-length']) {
                    // Not already set (i.e. not a HEAD response) — compute it
                    headers['content-length'] = decodedBody.length;
                }
                pending.res.writeHead(msg.status, headers);
                pending.res.end(decodedBody);
            }
        }
    });
});

// --- Public port (4000): Proxy incoming HTTP traffic through the tunnel ---
const publicServer = http.createServer((req, res) => {
    // Health check endpoint — short-circuit BEFORE subdomain lookup.
    // Confirms Node is alive and handling requests independently of tunnels.
    const pathname = req.url?.split('?')[0];
    if (pathname === '/_tunnel_health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    // Force browsers to open a fresh connection per request rather than reusing
    // keep-alive sockets. For a high-traffic proxy this would hurt performance,
    // but for a personal tunnel the WebSocket round-trip dominates latency anyway,
    // and this prevents edge cases where a browser reuses a half-open socket that
    // the tunnel hasn't fully cleared yet.
    res.setHeader('Connection', 'close');

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
    let aborted = false; // guards against end firing after a 413 rejection

    // Log each proxied request for easy debugging
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

    // If the browser tab closes mid-upload, this prevents an unhandled
    // exception from taking down the server process
    req.on('error', (err) => {
        console.error('Public request error:', err.message);
        if (!res.headersSent) {
            res.statusCode = 400;
            res.end();
        }
    });

    req.on('end', () => {
        if (aborted) return; // 413 already sent — don't forward the request

        // Register the pending request before sending, so the close handler
        // can clean it up immediately if the client disconnects mid-flight
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            tunnelRequests.get(subdomain)?.delete(requestId);
            // Guard against future code paths that might write headers before
            // this timer fires without clearing it — cheap insurance
            if (res.headersSent) return;
            res.writeHead(504, { 'Content-Type': 'text/plain' });
            res.end('Gateway Timeout: local server did not respond in time');
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(requestId, { res, timer, subdomain });
        tunnelRequests.get(subdomain)?.add(requestId);

        // The WebSocket could close between the readyState check at the top
        // and this send — wrap in try/catch and return a 502 if it fails
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

// --- Graceful shutdown: drain in-flight requests, notify clients, then exit ---
// Last-resort error handlers — if anything slips through the try/catch coverage,
// log it before exiting so PM2's restart gives you something to debug.
// Without this, a crash is silent: the process dies and all you know is
// that active tunnels disappeared.
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

    // 1. Return 503 immediately for all pending in-flight HTTP requests.
    //    Without this, browsers get a TCP reset with no explanation.
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

    // 2. Notify all tunnel clients so they can start reconnecting immediately
    //    rather than waiting for a TCP timeout to tell them the connection is gone
    for (const [, ws] of tunnels) {
        try {
            ws.send(JSON.stringify({ type: 'shutdown', message: 'Server restarting, please reconnect' }));
        } catch {}
    }

    // 3. Brief delay to allow messages to flush, then close cleanly
    setTimeout(() => {
        publicServer.close();
        controlServer.close();
        process.exit(0);
    }, 2000);
});

publicServer.listen(4000, () => console.log('Public proxy listening on :4000'));
console.log('Control server listening on :4001 (via nginx /tunnel-control)');

// SIGINT (Ctrl+C during development) should drain the same way as SIGTERM.
// Without this, hitting Ctrl+C skips the pending request drain entirely.
process.on('SIGINT', () => process.emit('SIGTERM'));
