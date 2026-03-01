# Build Your Own Tunnel Service
### A Complete Technical Architecture & Implementation Plan
*An ngrok-style reverse tunnel system you own and control*

---

## 1. Overview & Goals

This document is a technical plan for building your own personal tunnel service — a system that exposes local web servers to the internet via a secure, persistent tunnel, similar to ngrok. Unlike ngrok, you own every piece of the infrastructure: the server, the domain, the code, and the data.

When complete, you will be able to run a simple command like:

```bash
tunnel 3000
# or with a persistent subdomain:
tunnel 3000 --subdomain my-app
```

...and receive back a public HTTPS URL like `https://abc123.yourdomain.com`, which routes traffic directly to your local port 3000. No third-party accounts, no data going through someone else's servers, and no monthly fees beyond your VPS cost.

### What This System Will Do

- Create a persistent, encrypted tunnel between your local machine and a public VPS
- Assign a unique subdomain (or a persistent one you specify) to each tunnel session, with explicit errors if the requested name is unavailable
- Forward HTTP/HTTPS traffic through the tunnel to your local server, with correct handling of binary data
- Terminate TLS/SSL at the VPS for both the public port and the control port
- Handle concurrent requests correctly without mixing up responses
- Enforce a 10MB request body limit to prevent memory exhaustion
- Detect and clean up dead connections automatically via heartbeats, including cleaning up any pending in-flight requests immediately on disconnect
- Require token-based authentication transmitted securely (not in URLs or logs)
- Auto-reconnect with exponential backoff when the tunnel drops
- Shut down gracefully so connected clients can reconnect quickly

### Known Limitations (Accepted Trade-offs)

| Feature | Current Approach | Notes |
|---------|-----------------|-------|
| Large file transfers | Full body buffered in memory | Streaming is significantly more complex; acceptable for a personal tool |
| Base64 memory overhead | Bodies Base64-encoded for JSON transport | Base64 inflates payload size by ~33% — a 10MB upload becomes ~13.3MB in memory. On a 1GB VPS, treat 5MB as a more realistic safe ceiling under concurrent load. Binary WebSocket frames would eliminate this overhead but require a more complex framing protocol. |
| High concurrency | Single WebSocket per tunnel | Head-of-line blocking possible under heavy load; fine for personal use |
| Scale | Single-server design | Map-based subdomain tracking works well for personal/small team use |

---

## 2. How It Works — Core Architecture

The system has three logical components that work together.

### Component 1: The VPS (Public Server)

A cloud server with a public IP address is the heart of the system. This is the only part that requires infrastructure you don't run on your own machine. A $5–6/month VPS from DigitalOcean, Linode, or Hetzner is sufficient.

The VPS is responsible for:

- Receiving authenticated tunnel connections from your local machine over TLS
- Validating the secret token sent as the first WebSocket message (not in the URL)
- Listening for incoming HTTP/HTTPS requests from the public internet
- Forwarding those public requests through the tunnel to your local machine, tagged with a unique request ID
- Returning your local server's response to the correct waiting HTTP response object
- Pinging connected clients every 30 seconds and dropping ghost connections that don't respond
- Immediately returning 502 for any in-flight requests when a client disconnects

### Component 2: The Tunnel Server (Software on VPS)

A Node.js server process runs on the VPS and manages the tunnel connections. All ports are fronted by nginx for TLS termination:

| Port (nginx) | Proxies To | Purpose |
|---|---|---|
| **443 /tunnel** | Node :4001 | Control port — accepts authenticated WebSocket connections from your local client |
| **443 /** | Node :4000 | Public port — accepts HTTP/HTTPS traffic from the internet and proxies it through the tunnel |

> **Why route the control port through nginx?** The WebSocket library itself does not speak TLS — it opens a plain socket. If the client connects with `wss://` directly to Node, the handshake fails. Routing port 2222 (or a path on 443) through nginx lets nginx handle TLS and forward a plain connection to Node. This also means the control connection gets the same wildcard certificate as everything else, and no extra firewall port needs to be opened beyond 443.

### Component 3: The Local Client (CLI Tool)

A small command-line tool you install on your development machine. When you run it, it:

- Connects outward to the VPS control path over `wss://` (outbound connections bypass NAT/firewalls)
- Sends the secret token as the **first WebSocket message** rather than in the URL, keeping it out of nginx logs and shell history
- Keeps the connection alive by responding to heartbeat pings
- Auto-reconnects with exponential backoff if the connection drops
- Handles each forwarded request by talking to your local server, with the Host header rewritten to avoid dev server rejections
- Collects the response body into a Buffer, Base64-encodes it, and sends it back tagged with the matching request ID

> **🔑 Key Insight:** The tunnel works because your client always initiates the outbound connection to the VPS. Firewalls and NAT routers block incoming connections, but they allow outgoing ones. Once your client has established that connection, the VPS can send data back through it — effectively punching through your firewall without any special configuration.

---

## 3. Infrastructure Requirements

### VPS (Virtual Private Server)

Any major cloud provider works. You need Ubuntu 22.04 or 24.04 LTS. The smallest available tier is more than sufficient.

| Provider | Recommended Plan & Cost |
|----------|------------------------|
| DigitalOcean | Basic Droplet — $6/month, 1 vCPU, 1GB RAM, 25GB SSD |
| Hetzner Cloud | CX11 — ~$4/month, 1 vCPU, 2GB RAM (best value) |
| Linode (Akamai) | Nanode — $5/month, 1 vCPU, 1GB RAM |
| AWS Lightsail | Nano — $3.50/month, 1 vCPU, 512MB RAM |

### Domain Name

You need a domain name pointed at your VPS IP. You'll use a wildcard DNS record so every subdomain automatically resolves to your server:

```
# DNS Records (set at your domain registrar or Cloudflare)
A      yourdomain.com       →  YOUR_VPS_IP
A      *.yourdomain.com     →  YOUR_VPS_IP   (wildcard — covers all subdomains)
```

A domain costs $10–15/year. Namecheap, Cloudflare Registrar, or Google Domains are all good options.

### SSL/TLS Certificate

You need HTTPS to serve traffic securely. Let's Encrypt provides free certificates. Because you're using a wildcard subdomain, you'll need a wildcard certificate, which requires DNS validation. Certbot with your DNS provider's plugin handles this automatically.

```bash
# Install certbot and DNS plugin (Cloudflare example)
sudo apt install certbot python3-certbot-dns-cloudflare

# Obtain wildcard certificate
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d yourdomain.com -d *.yourdomain.com
```

Certificate files will be placed at:
- `/etc/letsencrypt/live/yourdomain.com/fullchain.pem`
- `/etc/letsencrypt/live/yourdomain.com/privkey.pem`

Certbot installs a systemd timer that renews certificates automatically, but wildcard certs using DNS validation require the credentials file (`~/.secrets/cloudflare.ini`) to still be accessible to the renewal process. Verify auto-renewal works before you forget about it:

```bash
sudo certbot renew --dry-run
```

If this fails, the certificate silently expires in 90 days and everything breaks with a TLS error that won't point back to the cert as the cause.

---

## 4. Technology Stack

The recommended stack uses Node.js throughout for simplicity — both the tunnel server and the local client are JavaScript. Go is noted as an alternative where it may be preferred.

| Component | Technology |
|-----------|-----------|
| VPS Tunnel Server | Node.js with the `ws` WebSocket library |
| Local CLI Client | Node.js or Go (Go produces a single binary, easier to distribute) |
| Reverse Proxy / TLS | nginx (handles SSL termination for all ports including the control port) |
| Process Manager | PM2 (keeps the Node server running after reboots) |
| Certificate Manager | Certbot with Let's Encrypt |
| Operating System | Ubuntu 22.04 or 24.04 LTS |

> **💡 Why WebSockets?** WebSockets provide a persistent, full-duplex connection over standard HTTP ports (80/443). This means the tunnel works even in environments that block arbitrary TCP ports, since the connection looks like normal web traffic to firewalls and corporate proxies. They also support binary frames natively, which we use to avoid corrupting image and file data.

---

## 5. Implementation Plan

The project is broken into four phases. **Authentication is included in Phase 2** — the server should never run without it, even briefly.

### Phase 1: VPS Setup & nginx Configuration

Start by getting your VPS ready and configuring nginx to route all traffic, including the WebSocket control connection. This is the foundation everything else sits on.

**Step 1.1 — Initial VPS Configuration**

```bash
# On your new VPS
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot

# Install Node.js 20 via NodeSource — Ubuntu's default apt package is Node 12,
# which is far too old. crypto.randomUUID() requires 15.6+, optional chaining
# requires 14+. The code will crash on startup without this step.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Create a non-root user for the tunnel service
sudo adduser tunneluser
sudo usermod -aG sudo tunneluser
```

**Step 1.2 — Firewall Setup**

Lock down the VPS immediately. Note that port 2222 is no longer needed — the control connection runs through nginx on 443.

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP (redirect to HTTPS)
sudo ufw allow 443   # HTTPS (public traffic + control WebSocket)
sudo ufw enable
```

**Step 1.3 — nginx Configuration**

nginx handles TLS for everything: public HTTP traffic, the WebSocket control connection, and the HTTP-to-HTTPS redirect. Create `/etc/nginx/sites-available/tunnel`:

```nginx
# SSL hardening — disable older protocol versions and enable session caching
# so repeat visitors don't pay full TLS handshake cost on every connection.
# These apply to all server blocks in this file.
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 10m;

# Separate rate limit zones for control and public traffic.
# 30r/m is appropriate for the control port (tunnel registration),
# but far too restrictive for public traffic — a single page load
# with 20 assets would nearly exhaust the burst. Keep them separate.
limit_req_zone $binary_remote_addr zone=control:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=public:10m  rate=120r/m;

# Default catch-all: drop requests to the raw VPS IP address.
# Without this, a request with a spoofed Host header sent directly
# to your IP could reach your Node.js code. nginx 444 closes the
# connection immediately with no response.
server {
    listen 80 default_server;
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    return 444;
}

# Redirect all HTTP traffic to HTTPS
server {
    listen 80;
    server_name yourdomain.com *.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    # Only wildcard subdomains are matched here — requests to the bare domain
    # (yourdomain.com) fall through to the catch-all and get dropped with 444.
    # This is intentional. If you want to host a landing page or health check
    # on the bare domain, add a separate server block for it explicitly.
    server_name *.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Control port — WebSocket connections from your local tunnel client.
    # Token authentication happens at the application layer (first WS message),
    # so the rate limit here acts as a brute-force speed bump.
    location /tunnel-control {
        limit_req zone=control burst=5;

        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_read_timeout 3600s; # Keep control connections alive
        # Disable buffering for the control WebSocket — heartbeat pings and
        # request-forward messages are small and latency-sensitive; buffering
        # adds unnecessary delay on the server-to-client direction.
        proxy_buffering off;
    }

    # Public traffic — incoming requests from the internet.
    # nodelay: process burst requests immediately rather than queuing them
    # at the base rate, which would add artificial latency to page loads.
    # Note: proxy_read_timeout defaults to 60s here. If you ever raise
    # REQUEST_TIMEOUT_MS above 60s in server.js, raise this to match.
    location / {
        limit_req zone=public burst=20 nodelay;

        # CRITICAL: nginx defaults to a 1MB body limit. Without this, any POST/PUT
        # larger than 1MB is rejected by nginx with 413 before reaching Node.js,
        # making the 10MB limit in server.js effectively dead code for larger payloads.
        # Set slightly above the Node limit to avoid off-by-one edge cases.
        client_max_body_size 11m;

        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        # Pass the public subdomain so Node can look up the right tunnel.
        # The client rewrites Host to localhost before hitting your local server.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        # Tell the local app the original request used HTTPS. Without this, frameworks
        # like Rails or Express (with trust proxy enabled) see an HTTP upstream connection
        # and trigger infinite SSL redirect loops trying to force the client to HTTPS.
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Step 1.4 — Activate the nginx configuration**

Writing the config file is not enough — nginx won't use it until it's enabled, the default conflicting site is removed, and the configuration is tested and reloaded. Skipping these steps leaves nginx silently serving the Ubuntu default welcome page regardless of what you wrote in Step 1.3.

```bash
# Remove Ubuntu's default nginx site — it also listens on port 80 and will conflict
sudo rm /etc/nginx/sites-enabled/default

# Enable the tunnel site by symlinking it into sites-enabled
sudo ln -s /etc/nginx/sites-available/tunnel /etc/nginx/sites-enabled/tunnel

# Test syntax before reloading — a typo here means nginx won't restart at all
sudo nginx -t

# Apply the configuration
sudo systemctl reload nginx
```

> **⚠️ Host Header Note:** nginx forwards the public subdomain (e.g., `abc123.yourdomain.com`) as the `Host` header. Many dev servers — Next.js, Vite, Webpack Dev Server — validate this header and will return an "Invalid Host Header" error if it doesn't match `localhost`. The local client rewrites the `Host` header to `localhost:PORT` by default before forwarding the request. Pass `--no-rewrite-host` to disable this if you specifically need the original host to reach your local server.

---

### Phase 2: Tunnel Server (Node.js on VPS)

**Step 2.1 — Create the server project and install dependencies**

```bash
mkdir ~/tunnel-server && cd ~/tunnel-server
npm init -y
npm install ws
```

**Step 2.2 — Write server.js**

The server manages two ports: the control port (authenticated WebSocket connections from your client) and the public port (incoming HTTP traffic). All of the following are included: timing-safe token comparison, maxPayload cap on the control server, token auth via first message, concurrent request routing with aborted-flag guard against 413/end races, try/catch around ws.send() for TOCTOU safety, binary-safe response handling, request body size limit, JSON error handling, request metadata logging, pending request drain on graceful shutdown, pending request cleanup on disconnect, and graceful SIGTERM shutdown.

```javascript
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
```

---

### Phase 3: Local Client (CLI Tool)

**Step 3.1 — Create the client project and install dependencies**

On your local development machine:

```bash
mkdir ~/tunnel-client && cd ~/tunnel-client
npm init -y
npm install ws
```

**Step 3.2 — Write client.js**

The client connects securely, sends the token as the first message, rewrites the Host header, handles binary data correctly, and auto-reconnects with exponential backoff when the connection drops.

```javascript
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

if (!TUNNEL_HOST) {
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
        console.log(`\nConnection closed (${code}): ${reason.toString()}`);
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
```

---

### Phase 4: Polish & Quality of Life

Once the core tunnel is solid, these are the most valuable remaining improvements:

- **Health check endpoint** — add a `/_tunnel_health` check *before* the subdomain lookup in the public server handler, not after. A request to `https://anything.yourdomain.com/_tunnel_health` would fail the subdomain lookup and return 404 if the check comes after routing. The correct pattern is to short-circuit at the top of the request handler: `if (req.url === '/_tunnel_health') { res.writeHead(200); res.end('ok'); return; }`. This confirms Node is alive and handling requests, independently of whether any tunnels are registered.
- **Request inspector dashboard** — a simple web UI showing live request/response history with headers and bodies
- **Binary CLI distribution** — compile with `pkg` (Node) or natively with Go for a single executable you can drop anywhere
- **Multiple tunnels** — run several tunnel clients simultaneously for different local ports
- **Response streaming** — for very large file transfers, stream body chunks over the WebSocket instead of buffering the full body (significantly more complex; treat as a stretch goal)

---

## 6. Security Summary

### Token Authentication

The secret token is sent as the **first WebSocket message** after the connection opens, not as a URL query parameter. Query parameters appear in nginx access logs, shell history, and process listings — none of which you want to contain your secret. The server closes any connection that doesn't present the correct token within 5 seconds of connecting.

Set the secret as an environment variable on both your VPS and local machine:

```bash
# On the VPS — start the server and persist it across reboots.
# pm2 save records the process list; pm2 startup installs a systemd hook
# so PM2 itself restarts after a reboot. Without these two lines, a VPS
# reboot kills the tunnel server permanently with no error message.
cd ~/tunnel-server
TUNNEL_SECRET=your-long-random-secret pm2 start server.js --name tunnel
pm2 save
pm2 startup   # follow the printed instruction to enable the systemd hook

# On your local machine
export TUNNEL_HOST=yourdomain.com
export TUNNEL_SECRET=your-long-random-secret
node client.js 3000
```

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Subdomain Validation & Rejection

Subdomain names are validated against `/^[a-z0-9][a-z0-9-]{0,62}$/` before being accepted. Names that don't match — including empty strings, names with dots or slashes, or prototype-poisoning strings like `__proto__` — are rejected with a clear error message. If a requested subdomain is already in use, the connection is rejected (not silently rerouted), so you always know exactly which URL your tunnel is on.

### Subdomain Persistence for Webhooks

If you're registering a callback URL with an external service (Stripe, GitHub, Twilio, etc.), use the `--subdomain` flag to guarantee a stable URL. If that name is unavailable, you'll get an explicit error rather than a silent reassignment:

```bash
tunnel 3000 --subdomain stripe-dev
# Produces: https://stripe-dev.yourdomain.com
# If stripe-dev is taken, the client exits with a clear error
```

---

## 7. Open-Source Alternatives to Build On

Rather than writing everything from scratch, you can self-host any of these open-source projects on your VPS. They handle the tunnel logic and you just configure them:

| Project | Description |
|---------|-------------|
| **frp** (Fast Reverse Proxy) | Written in Go. Very popular, well-documented. Supports HTTP, HTTPS, TCP, UDP. Run `frps` on VPS and `frpc` on your machine. |
| **bore** | Minimal Rust tool. Single binary, dead simple. Run `bore server` on VPS and `bore local 3000 --to yourhost.com` locally. |
| **Cloudflare Tunnel** | Free and excellent. No VPS needed — Cloudflare provides the infrastructure. Great if you don't want to manage a server. |
| **rathole** | Rust-based, optimized for high performance and stability. Good for production self-hosting. |
| **localtunnel** | Node.js based, easy to self-host. Less maintained but simple codebase to learn from. |

> **💡 Recommendation:** If you want to build from scratch to learn, follow the plan above. If you want something working today, deploy **frp** on a Hetzner VPS — it takes about 30 minutes and gives you a fully functional personal tunnel service identical in capability to ngrok.

---

## 8. Recommended Build Order

When you start the actual implementation, follow this sequence to avoid compounding frustration. Each step validates something independently before the next layer of complexity is added.

**Step 1 — DNS first, before anything else**
Point your A records at the VPS IP immediately and let them propagate while you work on everything else. DNS propagation can take 30 minutes to a few hours depending on your registrar — it's the one thing you can't accelerate. If you wait until the end to set up DNS, you'll be sitting idle.

**Step 2 — SSL and nginx with a static response**
Get your wildcard certificate and nginx configuration working before writing a single line of Node.js. Confirm it by serving a static "Hello World" from nginx directly. This isolates the infrastructure: if your cert is wrong, your nginx config has a syntax error, or your wildcard subdomain routing isn't working, you want to know now — not after you've added a Node server into the picture and have two layers to debug simultaneously.

```bash
# Quick test — should return 200 from the public internet
curl -I https://test.yourdomain.com
```

**Step 3 — Deploy server.js and verify the control port**
Start the Node server and confirm a tunnel client can connect and register. Don't worry about proxying real traffic yet — just get the WebSocket handshake, authentication, and subdomain assignment working end-to-end.

**Step 4 — Integration test with a simple local server**
Before pointing the tunnel at your real app, validate the full proxy chain with Python's built-in HTTP server:

```bash
# On your local machine — serves the current directory on port 3000
python3 -m http.server 3000
TUNNEL_HOST=yourdomain.com TUNNEL_SECRET=your-secret node client.js 3000
```

Then hit the tunnel URL from a browser. If you see a directory listing, the full path works: DNS → nginx → Node → WebSocket → client → localhost. Only after this passes should you swap in your real application.

---

## 9. Estimated Build Timeline

| Phase | Estimated Time |
|-------|---------------|
| VPS provisioning and initial setup | 1–2 hours |
| Domain and DNS configuration | 30 minutes (+ propagation time) |
| SSL certificate setup | 30 minutes |
| nginx configuration (public + control + HTTP redirect) | 1 hour |
| Tunnel server with auth, concurrency, size limits, graceful shutdown (Phase 2) | 8–12 hours |
| Local client with reconnect, binary handling, host rewriting (Phase 3) | 4–6 hours |
| Polish and dashboard (Phase 4) | 4–8 hours |
| **Total (build from scratch)** | **~3 days of focused work** |
| **Total (using frp or bore)** | **1–2 hours** |

---

## 10. Change Log

| Version | Changes |
|---------|---------|
| v1 | Initial design |
| v2 | Added requestId concurrency fix, Base64 binary handling, heartbeats, auth token, host header rewriting, rate limiting, subdomain persistence |
| v3 | Fixed TLS on control port (routed through nginx); moved token from URL query param to first WS message; added request body size limit (10MB); added try/catch on all JSON.parse calls; subdomain validation regex; explicit rejection when requested subdomain is taken; pending request cleanup on client disconnect; graceful SIGTERM shutdown; HTTP→HTTPS redirect in nginx; Content-Length header stripped from proxied responses; auto-reconnect moved from Phase 4 to Phase 3; health check endpoint added to Phase 4 |
| v4 | Set Content-Length from decoded buffer length (fixes chunked encoding hangs in curl/browsers); added default nginx catch-all server block to drop raw IP requests; added Base64 memory overhead warning to Known Limitations; send structured JSON error message before closing on subdomain collision; added req.on('error') handler in publicServer to prevent unhandled exceptions on browser tab close; added hop-by-hop header filtering on client (strips connection, keep-alive, transfer-encoding before forwarding responses) |
| v5 | Fixed 413/end race condition with aborted flag; wrapped ws.send() in try/catch with 502 fallback for TOCTOU safety; moved clearTimeout before try/catch in auth handler; added constantTimeEqual() for timing-safe token comparison; added maxPayload: 16MB to control server; added error message type handler in client so structured errors reach the terminal; client now exits permanently on 1008 close code instead of reconnecting in a loop; graceful shutdown now drains pendingRequests with 503+Retry-After before closing; split nginx rate limit into separate control (30r/m) and public (120r/m) zones; added nodelay to public rate limit; added request metadata logging in publicServer |
| v6 | Added client_max_body_size 11m to nginx public location (nginx 1MB default was silently killing requests before they reached Node); wrapped both client-side ws.send() calls in try/catch so a dropped tunnel during response forwarding doesn't crash the client process; added res.headersSent guard to 504 timeout callback; added SIGINT handler delegating to SIGTERM so Ctrl+C during development triggers graceful drain; added .toString() to reason in ws close handler for compatibility with newer ws library versions that return a Buffer |
| v7 | Strip transfer-encoding on server side before writeHead (local app chunked encoding + recomputed Content-Length was malformed HTTP, causing nginx 502); added Connection: close to all public server responses to prevent half-open socket edge cases with browser keep-alive; added ECONNREFUSED-specific error message in client pointing user to check their local server port |
| v8 | Added res.headersSent guard to disconnect cleanup loop and SIGTERM drain loop (missing guard could crash server if 413/error/timeout already wrote headers); defaulted msg.body to empty string to handle 204/HEAD responses without throwing TypeError; added uncaughtException and unhandledRejection handlers for last-resort crash logging; added msg.requestId guard in client request handler to fail fast on malformed messages instead of 30-second silent hang; added proxy_buffering off to tunnel-control nginx location; added SSL hardening block (TLS 1.2/1.3 only, session caching); clarified health check must short-circuit before subdomain lookup in publicServer |
| v9 | Added X-Forwarded-Proto header to nginx public location (prevents SSL redirect loops in Rails/Express apps that check request protocol); added 204 No Content status check to suppress Content-Length on those responses per RFC 7230; connectionId prefix suggestion evaluated and declined — server restart clears pendingRequests entirely so stale IDs have no live entry to match, UUID collision risk is negligible for a personal tool |
| v10 | Added npm init + npm install ws setup steps to Phase 2 (server) and Phase 3 (client); replaced Ubuntu apt nodejs with NodeSource Node 20 install (apt ships Node 12 which crashes on randomUUID, optional chaining, etc.); fixed HEAD response Content-Length — client now preserves original header for HEAD requests, server skips recomputing it when already present; added pm2 save + pm2 startup to PM2 instructions so server survives reboots; added certbot --dry-run renewal verification note; added nginx comment clarifying bare domain catch-all is intentional |
| v11 | Added Section 8: Recommended Build Order — DNS first, then SSL/nginx with static validation, then Node server, then integration test with python3 -m http.server before real app; sections renumbered accordingly. Reviewer observations confirmed as validations: 30s Node timeout correctly fires before 60s nginx timeout; SSL session cache sizing (10MB ≈ 40k sessions) appropriate for personal use |
| v12 | Added Step 1.4: nginx activation steps (symlink to sites-enabled, remove default site, nginx -t syntax check, systemctl reload) — without these nginx ignores the config entirely; replaced hardcoded VPS_HOST in client with TUNNEL_HOST environment variable to match existing pattern and make client distributable without source edits; updated all usage examples to include TUNNEL_HOST |

---

## 11. Useful References

- ngrok open-source alternative comparison: [github.com/anderspitman/awesome-tunneling](https://github.com/anderspitman/awesome-tunneling)
- frp documentation: [github.com/fatedier/frp](https://github.com/fatedier/frp)
- bore (Rust): [github.com/ekzhang/bore](https://github.com/ekzhang/bore)
- Let's Encrypt / Certbot: [certbot.eff.org](https://certbot.eff.org)
- WebSocket spec (RFC 6455): [datatracker.ietf.org/doc/html/rfc6455](https://datatracker.ietf.org/doc/html/rfc6455)
- nginx reverse proxy guide: [nginx.org/en/docs/http/ngx_http_proxy_module.html](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- Node.js `ws` library: [github.com/websockets/ws](https://github.com/websockets/ws)

---

*End of Document*
