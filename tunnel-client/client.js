#!/usr/bin/env node
// client.js — runs on your local machine
// Usage: node client.js <port> [--subdomain <name>] [--no-rewrite-host]
const WebSocket = require('ws');
const http = require('http');

const args = process.argv.slice(2);
const LOCAL_PORT = parseInt(args[0]) || 3000;
const subdomainFlag = args.indexOf('--subdomain');
const requestedSubdomain = subdomainFlag !== -1 ? args[subdomainFlag + 1] : null;
const rewriteHost = !args.includes('--no-rewrite-host');

const VPS_HOST = process.env.TUNNEL_HOST;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

if (!VPS_HOST) {
    console.error('FATAL: TUNNEL_HOST environment variable is required');
    process.exit(1);
}
if (!TUNNEL_SECRET) {
    console.error('FATAL: TUNNEL_SECRET environment variable is required');
    process.exit(1);
}

// --- Auto-reconnect with exponential backoff ---
let retryDelay = 1000;
const MAX_RETRY_DELAY = 30_000;

function connect() {
    console.log(`Connecting to ${VPS_HOST}...`);
    const ws = new WebSocket(`wss://${VPS_HOST}/tunnel-control`);

    ws.on('open', () => {
        // Send token as the first message — never in the URL
        const authMsg = { type: 'auth', token: TUNNEL_SECRET };
        if (requestedSubdomain) authMsg.subdomain = requestedSubdomain;
        ws.send(JSON.stringify(authMsg));
        retryDelay = 1000; // Reset backoff on successful connection
    });

    // Respond to server heartbeat pings
    ws.on('ping', () => ws.pong());

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); }
        catch { console.error('Received malformed message from server'); return; }

        if (msg.type === 'registered') {
            console.log(`\n✓ Tunnel active: https://${msg.subdomain}.${VPS_HOST}\n`);
        }

        // Server sends a structured error before closing on auth/validation failures.
        // Display it now so the user sees the full reason, not just the close code.
        if (msg.type === 'error') {
            console.error(`\n✗ Server error: ${msg.message}`);
        }

        if (msg.type === 'shutdown') {
            console.log(`\nServer is restarting: ${msg.message}`);
            // Close cleanly — the reconnect logic below will handle recovery
            ws.close();
        }

        if (msg.type === 'request') {
            // Guard: a malformed request without requestId causes a silent 30-second hang
            // (pendingRequests.get(undefined) returns undefined, response is dropped).
            // Fail fast and visibly instead.
            if (!msg.requestId) {
                console.error('Received request message with no requestId — ignoring');
                return;
            }

            const headers = { ...msg.headers };
            if (rewriteHost) {
                // Rewrite Host so dev servers (Next.js, Vite, etc.) don't reject the request
                headers['host'] = `localhost:${LOCAL_PORT}`;
            }

            const options = {
                hostname: 'localhost',
                port: LOCAL_PORT,
                path: msg.path,
                method: msg.method,
                headers
            };

            const localReq = http.request(options, (localRes) => {
                // Collect as binary Buffers — never string concatenation
                const chunks = [];
                localRes.on('data', chunk => chunks.push(chunk));
                localRes.on('end', () => {
                    const body = Buffer.concat(chunks);

                    // Strip hop-by-hop headers that must not be forwarded through a proxy.
                    // Passing 'transfer-encoding: chunked' when we're sending a complete
                    // buffer confuses nginx and some browsers; 'connection' and 'keep-alive'
                    // are managed by the tunnel layer, not the application layer.
                    const headers = { ...localRes.headers };
                    // For HEAD requests, preserve the original Content-Length — it reflects
                    // what a GET would return (RFC 7230 §3.3.2). The body is empty by spec,
                    // so if we strip it the server recomputes it as 0, which breaks caching
                    // proxies and pre-flight size checks. For everything else, strip it and
                    // let the server recompute it from the actual decoded buffer.
                    if (msg.method !== 'HEAD') {
                        delete headers['content-length'];
                    }
                    delete headers['connection'];
                    delete headers['keep-alive'];
                    delete headers['transfer-encoding'];

                    // If the tunnel drops while the local response is in flight,
                    // ws.send() throws — catch it so the process doesn't crash
                    // (the reconnect loop handles recovery, but only if we're still running)
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
                // Give the user a specific, actionable message for the most common
                // failure: the local server isn't running or is on the wrong port.
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
    });

    ws.on('close', (code, reason) => {
        if (code === 1008) {
            // 1008 = auth or validation rejection — retrying will not help
            // and would hammer the server in an infinite loop.
            // The error message was already printed by the 'error' message handler above.
            console.error(`\nConnection permanently rejected by server. Exiting.`);
            process.exit(1);
        }
        const reasonStr = Buffer.isBuffer(reason) ? reason.toString() : String(reason);
        console.log(`\nConnection closed (${code}): ${reasonStr}`);
        console.log(`Reconnecting in ${retryDelay / 1000}s...`);
        setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
            connect();
        }, retryDelay);
    });

    ws.on('error', (err) => {
        console.error(`Connection error: ${err.message}`);
        // The 'close' event fires after 'error', so reconnect logic runs there
    });
}

connect();
