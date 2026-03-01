#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: tunnel <port> [options]

Options:
  --subdomain <name>   Request a specific subdomain (e.g. my-app)
  --no-rewrite-host    Don't rewrite the Host header to localhost
  --help, -h           Show this help message

Environment variables:
  TUNNEL_HOST          Required. Your tunnel server domain (e.g. yourdomain.com)
  TUNNEL_SECRET        Required. Shared secret for authentication

Examples:
  tunnel 3000
  tunnel 8080 --subdomain my-app
  TUNNEL_HOST=yourdomain.com TUNNEL_SECRET=secret tunnel 3000
`);
    process.exit(0);
}

const LOCAL_PORT = parseInt(args[0]) || 3000;
const subdomainFlag = args.indexOf('--subdomain');
const requestedSubdomain = subdomainFlag !== -1 ? args[subdomainFlag + 1] : null;
const rewriteHost = !args.includes('--no-rewrite-host');

const TUNNEL_HOST = process.env.TUNNEL_HOST;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

if (!TUNNEL_HOST) {
    console.error('FATAL: TUNNEL_HOST environment variable is required');
    process.exit(1);
}
if (!TUNNEL_SECRET) {
    console.error('FATAL: TUNNEL_SECRET environment variable is required');
    process.exit(1);
}

let retryDelay = 1000;
const MAX_RETRY_DELAY = 30_000;

function connect() {
    console.log(`Connecting to ${TUNNEL_HOST}...`);
    const ws = new WebSocket(`wss://${TUNNEL_HOST}/tunnel-control`);

    ws.on('open', () => {
        const authMsg = { type: 'auth', token: TUNNEL_SECRET };
        if (requestedSubdomain) authMsg.subdomain = requestedSubdomain;
        ws.send(JSON.stringify(authMsg));
        retryDelay = 1000;
    });

    ws.on('ping', () => ws.pong());

    const localWebSockets = new Map(); // connectionId → WebSocket (established)
    const pendingWsConnections = new Map(); // connectionId → { localWs, buffer }

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); }
        catch { console.error('Received malformed message from server'); return; }

        if (msg.type === 'registered') {
            console.log(`\n✓ Tunnel active: https://${msg.subdomain}.${TUNNEL_HOST}`);
            console.log(`  Forwarding to localhost:${LOCAL_PORT}\n`);
        }

        if (msg.type === 'error') {
            console.error(`\n✗ Server error: ${msg.message}`);
        }

        if (msg.type === 'shutdown') {
            console.log(`\nServer is restarting: ${msg.message}`);
            ws.close();
        }

        if (msg.type === 'request') {
            if (!msg.requestId) {
                console.error('Received request message with no requestId — ignoring');
                return;
            }

            const headers = { ...msg.headers };
            if (rewriteHost) {
                headers['host'] = `localhost:${LOCAL_PORT}`;
            }

            const options = {
                hostname: 'localhost',
                port: LOCAL_PORT,
                path: msg.path,
                method: msg.method,
                headers
            };

            console.log(`[←] ${msg.method} ${msg.path}`);

            const localReq = http.request(options, (localRes) => {
                const chunks = [];
                localRes.on('data', chunk => chunks.push(chunk));
                localRes.on('end', () => {
                    const body = Buffer.concat(chunks);

                    const headers = { ...localRes.headers };
                    if (msg.method !== 'HEAD') {
                        delete headers['content-length'];
                    }
                    delete headers['connection'];
                    delete headers['keep-alive'];
                    delete headers['transfer-encoding'];

                    try {
                        ws.send(JSON.stringify({
                            type: 'response',
                            requestId: msg.requestId,
                            status: localRes.statusCode,
                            headers,
                            body: body.toString('base64')
                        }));
                    } catch (e) {
                        console.error('Failed to send response — tunnel dropped:', e.message);
                    }
                });
            });

            localReq.on('error', (err) => {
                if (err.code === 'ECONNREFUSED') {
                    console.error(`✗ Connection refused on localhost:${LOCAL_PORT} — is your local server actually running?`);
                } else {
                    console.error(`Local server error: ${err.message}`);
                }
                try {
                    ws.send(JSON.stringify({
                        type: 'response',
                        requestId: msg.requestId,
                        status: 502,
                        headers: { 'content-type': 'text/plain' },
                        body: Buffer.from('Bad Gateway: local server unreachable').toString('base64')
                    }));
                } catch (e) {
                    console.error('Failed to send error response — tunnel dropped:', e.message);
                }
            });

            if (msg.body) localReq.write(Buffer.from(msg.body, 'base64'));
            localReq.end();
        }

        if (msg.type === 'ws-connect') {
            if (!msg.connectionId || !msg.path) {
                console.error('Received ws-connect with missing connectionId or path — ignoring');
                return;
            }

            const url = `ws://localhost:${LOCAL_PORT}${msg.path}`;
            const headers = { ...msg.headers };
            if (rewriteHost) {
                headers['host'] = `localhost:${LOCAL_PORT}`;
            }

            console.log(`[ws] connectionId=${msg.connectionId} connecting to ${url}`);

            const localWs = new WebSocket(url, { headers });
            const frameBuffer = [];
            pendingWsConnections.set(msg.connectionId, { localWs, buffer: frameBuffer });

            localWs.on('open', () => {
                const responseHeaders = localWs.protocol ? { 'Sec-WebSocket-Protocol': localWs.protocol } : {};
                try {
                    ws.send(JSON.stringify({
                        type: 'ws-connect-response',
                        connectionId: msg.connectionId,
                        status: 101,
                        headers: { Upgrade: 'websocket', Connection: 'Upgrade', ...responseHeaders }
                    }));
                } catch (e) {
                    console.error('Failed to send ws-connect-response:', e.message);
                    localWs.close();
                    pendingWsConnections.delete(msg.connectionId);
                    return;
                }
                localWebSockets.set(msg.connectionId, localWs);
                pendingWsConnections.delete(msg.connectionId);
                for (const frame of frameBuffer) {
                    try {
                        localWs.send(Buffer.from(frame.data, 'base64'), { binary: frame.isBinary });
                    } catch (e) {
                        try { ws.send(JSON.stringify({ type: 'ws-close', connectionId: msg.connectionId, code: 1011, reason: 'Send failed' })); } catch {}
                        localWebSockets.delete(msg.connectionId);
                        return;
                    }
                }
            });

            localWs.on('message', (data, isBinary) => {
                try {
                    ws.send(JSON.stringify({
                        type: 'ws-frame',
                        connectionId: msg.connectionId,
                        isBinary: !!isBinary,
                        data: (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('base64')
                    }));
                } catch (e) {
                    console.error('Failed to send ws-frame:', e.message);
                    try { localWs.close(); } catch {}
                }
            });

            localWs.on('close', (code, reason) => {
                const wasPending = pendingWsConnections.has(msg.connectionId);
                pendingWsConnections.delete(msg.connectionId);
                localWebSockets.delete(msg.connectionId);

                if (wasPending) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'ws-connect-response',
                            connectionId: msg.connectionId,
                            status: 502,
                            headers: { 'Content-Type': 'text/plain' },
                            body: Buffer.from(`Connection closed before handshake (code=${code})`).toString('base64')
                        }));
                    } catch {}
                } else {
                    try {
                        ws.send(JSON.stringify({
                            type: 'ws-close',
                            connectionId: msg.connectionId,
                            code,
                            reason: (reason && reason.toString) ? reason.toString() : (reason || '')
                        }));
                    } catch {}
                }
                console.log(`[ws] connectionId=${msg.connectionId} closed by local server (code=${code})`);
            });

            localWs.on('error', (err) => {
                const errMsg = err.message || 'Connection failed';
                try {
                    ws.send(JSON.stringify({
                        type: 'ws-connect-response',
                        connectionId: msg.connectionId,
                        status: 502,
                        headers: { 'Content-Type': 'text/plain' },
                        body: Buffer.from(`Bad Gateway: ${errMsg}`).toString('base64')
                    }));
                } catch (e) {
                    console.error('Failed to send ws-connect-response (error):', e.message);
                }
                localWebSockets.delete(msg.connectionId);
                pendingWsConnections.delete(msg.connectionId);
                console.log(`[ws] connectionId=${msg.connectionId} error: ${errMsg}`);
            });
        }

        if (msg.type === 'ws-frame') {
            const localWs = localWebSockets.get(msg.connectionId);
            if (localWs) {
                try {
                    if (localWs.readyState === WebSocket.OPEN) {
                        localWs.send(Buffer.from(msg.data || '', 'base64'), { binary: !!msg.isBinary });
                    }
                } catch (e) {
                    try { ws.send(JSON.stringify({ type: 'ws-close', connectionId: msg.connectionId, code: 1011, reason: 'Send failed' })); } catch {}
                    localWebSockets.delete(msg.connectionId);
                }
            } else {
                const pending = pendingWsConnections.get(msg.connectionId);
                if (pending) {
                    pending.buffer.push({ isBinary: !!msg.isBinary, data: msg.data });
                }
            }
        }

        if (msg.type === 'ws-close') {
            const localWs = localWebSockets.get(msg.connectionId);
            const pending = pendingWsConnections.get(msg.connectionId);
            pendingWsConnections.delete(msg.connectionId);
            if (localWs) {
                try {
                    if (localWs.readyState === WebSocket.OPEN || localWs.readyState === WebSocket.CLOSING) {
                        localWs.close(msg.code || 1000, msg.reason || '');
                    }
                } catch {}
                localWebSockets.delete(msg.connectionId);
                console.log(`[ws] connectionId=${msg.connectionId} closed by server (code=${msg.code})`);
            } else if (pending) {
                try {
                    pending.localWs.close(msg.code || 1000, msg.reason || '');
                } catch {}
                console.log(`[ws] connectionId=${msg.connectionId} closed by server while connecting (code=${msg.code})`);
            }
        }
    });

    ws.on('close', (code, reason) => {
        for (const [, localWs] of localWebSockets) {
            try { localWs.close(1011, 'Tunnel disconnected'); } catch {}
        }
        for (const [, pending] of pendingWsConnections) {
            try { pending.localWs.close(1011, 'Tunnel disconnected'); } catch {}
        }
        localWebSockets.clear();
        pendingWsConnections.clear();
        if (code === 1008) {
            console.error(`\nConnection permanently rejected by server. Exiting.`);
            process.exit(1);
        }
        console.log(`\nConnection closed (${code}): ${reason.toString()}`);
        console.log(`Reconnecting in ${retryDelay / 1000}s...`);
        setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
            connect();
        }, retryDelay);
    });

    ws.on('error', (err) => {
        console.error(`Connection error: ${err.message}`);
    });
}

connect();
