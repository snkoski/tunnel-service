# tunnel-service

Self-hosted ngrok-style reverse tunnel service.

## What is implemented

- `server/server.js`: VPS tunnel server (public HTTP ingress + control WebSocket ingress)
- `client/client.js`: local CLI tunnel client
- Token auth as first WebSocket message
- Requested/random subdomain assignment with validation
- Request routing by `requestId` with timeout handling
- 10 MB request limit on the public server path
- Heartbeats for dead-connection detection
- Graceful shutdown + client reconnect support

## Local development

### 1) Start server (simulates VPS app layer)

```bash
cd server
export TUNNEL_SECRET=replace-with-random-secret
npm start
```

### 2) Start local app to expose

```bash
python3 -m http.server 3000
```

### 3) Start tunnel client

```bash
cd client
export TUNNEL_HOST=tunnel.shawnkoski.com
export TUNNEL_SECRET=replace-with-random-secret
npm start -- 3000 --subdomain my-app
```

## Required production topology

- nginx on VPS terminates TLS and proxies:
  - `https://*.tunnel.shawnkoski.com/tunnel-control` -> `http://127.0.0.1:4001`
  - `https://*.tunnel.shawnkoski.com/*` -> `http://127.0.0.1:4000`
- wildcard DNS (`A tunnel.shawnkoski.com`, `A *.tunnel.shawnkoski.com`) points to VPS
- wildcard TLS cert installed for `tunnel.shawnkoski.com` and `*.tunnel.shawnkoski.com` (e.g. Let's Encrypt DNS challenge)

## Next build items

- Add tests for request lifecycle and disconnect edge-cases
- Add request inspector endpoint/UI
- Package client as distributable binary
