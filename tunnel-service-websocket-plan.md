# WebSocket Tunneling Extension Plan
### Adding Application-Level WebSocket Support to the Tunnel Service
*Extends the base tunnel service so apps using HTTP, HTTPS, or WebSockets all work through the same tunnel*

---

## 1. Overview & Goals

This document is a technical plan for **extending** the existing tunnel service (see `tunnel-service-plan.md`) to support **application-level WebSocket connections**. After implementing this plan, your tunnel will handle:

| Traffic Type | Before | After |
|--------------|--------|-------|
| HTTP requests | ✅ Supported | ✅ Supported |
| HTTPS requests | ✅ Supported | ✅ Supported |
| WebSocket connections (`wss://`) | ❌ Not supported | ✅ Supported |

### What This Extension Adds

- **Detect WebSocket upgrade requests** — When a client connects with `Upgrade: websocket`, treat it as a WebSocket tunnel rather than a regular HTTP request
- **Bidirectional proxying** — Pipe WebSocket frames in both directions: public client ↔ VPS ↔ tunnel ↔ local server
- **Connection lifecycle** — Track each proxied WebSocket connection, clean up on close, and handle tunnel client disconnect
- **Same subdomain, same port** — WebSocket connections use the same `https://abc123.yourdomain.com` URL; the path determines whether it's HTTP or WebSocket (e.g., `wss://abc123.yourdomain.com/ws`)

### Prerequisites

This plan assumes you have completed the base tunnel service from `tunnel-service-plan.md`. You need:

- VPS with nginx, Node.js, and the tunnel server running
- Local client that connects to the control WebSocket
- Working HTTP/HTTPS tunneling

> **Control WebSocket heartbeat:** The base tunnel plan already includes a 30-second ping/pong heartbeat on the control WebSocket to detect dead connections. Ensure this remains in place — the WebSocket extension multiplexes over that same connection, and idle proxied WebSockets rely on the control channel staying alive.

---

## 2. How WebSocket Proxying Differs from HTTP

### HTTP (Current Behavior)

```
Browser --[HTTP request]--> VPS --[JSON over control WS]--> Local Client --[HTTP]--> localhost:3000
Browser <--[HTTP response]-- VPS <--[JSON over control WS]-- Local Client <--[HTTP]-- localhost:3000
```

- **Request/response** — One request, one response, connection closes (or reuses for keep-alive)
- **Single round-trip** — The tunnel sends a `request` message, waits for a `response` message
- **Stateless per request** — Each HTTP request has a unique `requestId`

### WebSocket (New Behavior)

```
Browser <--[bidirectional WebSocket]--> VPS <--[control WebSocket]--> Local Client <--[WebSocket]--> localhost:3000
```

- **Long-lived bidirectional stream** — Connection stays open; frames flow both ways continuously
- **Upgrade handshake first** — Initial HTTP request with `Upgrade: websocket`; response is `101 Switching Protocols`; then raw WebSocket frames
- **Connection tracking** — Each proxied WebSocket needs a persistent `connectionId` for the lifetime of the connection
- **Frame relay** — After the handshake, we relay WebSocket frames (text, binary, ping, pong, close) without interpreting them

> **🔑 Key Insight:** The tunnel control WebSocket is **multiplexed**: it carries both HTTP request/response pairs (existing) and WebSocket connection pipes (new). We distinguish them by message type. Each proxied WebSocket gets a unique `connectionId`; all frames for that connection are tagged with it.

---

## 3. Protocol Extension

### New Message Types (Tunnel Control Channel)

All messages use the existing JSON-over-WebSocket format. New types extend the protocol without breaking existing `request`/`response` handling.

| Direction | Type | Purpose |
|-----------|------|---------|
| Server → Client | `ws-connect` | Incoming WebSocket upgrade request; client should connect to localhost and complete handshake |
| Client → Server | `ws-connect-response` | Result of local WebSocket handshake (success with headers, or failure with status/headers) |
| Server → Client | `ws-frame` | WebSocket frame from public client → relay to local |
| Client → Server | `ws-frame` | WebSocket frame from local server → relay to public client |
| Both | `ws-close` | Connection closed; clean up and stop relaying |

### Message Schemas

**`ws-connect`** (Server → Client)

Include the full path and query string — many apps pass auth tokens or room IDs via query params (e.g., `?token=abc123`, `?room=lobby`). Use `req.url` from the upgrade request.

```json
{
  "type": "ws-connect",
  "connectionId": "uuid",
  "path": "/ws?token=abc123",
  "headers": {
    "host": "...",
    "upgrade": "websocket",
    "sec-websocket-protocol": "graphql-ws"
  }
}
```

**`ws-connect-response`** (Client → Server)

The 101 is never sent to the public client — the VPS already accepted the upgrade. This message signals "local connection succeeded" so the VPS can flush buffered frames.

```json
// Success — local side ready
{
  "type": "ws-connect-response",
  "connectionId": "uuid",
  "status": 101,
  "headers": { "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Accept": "..." }
}

// Failure (e.g., local server rejected)
{
  "type": "ws-connect-response",
  "connectionId": "uuid",
  "status": 502,
  "headers": { "Content-Type": "text/plain" },
  "body": "base64-encoded-error-message"
}
```

**`ws-frame`** (Both directions)
```json
{
  "type": "ws-frame",
  "connectionId": "uuid",
  "isBinary": true,
  "data": "base64"
}
```

Use `isBinary` to match the Node.js `ws` library's `message` event signature — `ws.on('message', (data, isBinary) => { ... })` — and relay with `ws.send(buffer, { binary: msg.isBinary })`. For V1, relay only data frames (text, binary); ping/pong are handled by each endpoint's keepalive. Close frames use `ws-close`.

**`ws-close`** (Both directions)

The Node.js `ws` library's close event gives `(code, reason)` where `reason` is a Buffer. Use `reason.toString()` when constructing the message — otherwise you get `[object Buffer]` in JSON. The reason is capped at 123 bytes per RFC 6455.

```json
{
  "type": "ws-close",
  "connectionId": "uuid",
  "code": 1000,
  "reason": "optional"
}
```

---

## 4. Architecture Changes

### Component 1: The Tunnel Server (Public Port)

**Current:** `http.createServer()` handles all requests as HTTP; forwards to tunnel; waits for response.

**New:** Must handle both HTTP and WebSocket upgrade requests on the same port.

| Incoming Request | Action |
|------------------|--------|
| Regular HTTP (no Upgrade) | Existing flow: forward as `request`, wait for `response` |
| WebSocket upgrade (`Upgrade: websocket`) | New flow: accept upgrade immediately, send `ws-connect`; on success, flush buffered frames; on failure, close public WebSocket |

**Changes required:**

1. **Upgrade handling** — Listen on `server.on('upgrade', (req, socket, head) => { ... })` for WebSocket upgrades. Do not check inside the request handler; the `upgrade` event is what fires, and it provides the `head` buffer.
2. **WebSocket server** — Attach a `WebSocket.Server` with `{ noServer: true }` to the same HTTP server so it can handle upgrade requests
3. **Connection map** — `Map<connectionId, WebSocket>` for public-side WebSocket connections
4. **Tunnel request tracking** — Extend `tunnelRequests` to include `connectionId`s for WebSocket connections (for cleanup on disconnect)
5. **Frame relay** — When a `ws-frame` arrives from the client, write it to the corresponding public WebSocket; when the public WebSocket receives a frame, send `ws-frame` to the client

### Component 2: The Local Client (CLI Tool)

**Current:** Handles `request` messages; makes HTTP request to localhost; sends `response`.

**New:** Handles `ws-connect` messages; establishes WebSocket to localhost; sends `ws-connect-response`; relays frames bidirectionally.

**Changes required:**

1. **`ws-connect` handler** — Parse message; create WebSocket connection to `ws://localhost:PORT${msg.path}` (path includes query string when present, e.g., `/ws?token=abc123`) with forwarded headers (rewrite Host if needed)
2. **Handshake response** — On `open` or `error`, send `ws-connect-response` with status and headers (for success, the `ws` library exposes the response headers)
3. **Frame relay** — On `message` from local WebSocket, send `ws-frame` to server; on `ws-frame` from server, write to local WebSocket (buffer incoming frames until local WebSocket is open)
4. **Close handling** — On local WebSocket close, send `ws-close`; on `ws-close` from server, close local WebSocket
5. **Connection map** — `Map<connectionId, WebSocket>` for local-side WebSocket connections

### Component 3: nginx

**No changes required.** nginx already forwards `Upgrade` and `Connection` headers to the Node backend (see the existing `proxy_set_header Upgrade $http_upgrade` in the public location). The Node server will handle the upgrade.

---

## 5. Implementation Plan

### Phase 1: Server-Side WebSocket Handling

**Step 1.1 — Attach WebSocket.Server with noServer**

Create a WebSocket server that doesn't listen on its own; it will handle upgrades from the HTTP server:

```javascript
const wssPublic = new WebSocket.Server({ noServer: true });
```

**Step 1.2 — Handle upgrade via server.on('upgrade')**

Listen on the HTTP server's `'upgrade'` event — do not check for WebSocket inside the normal request handler. The `'upgrade'` event is what fires for WebSocket upgrade requests; the request handler may not fire at all depending on Node version and setup. The event provides `head`, which can contain bytes already read from the socket; passing `Buffer.alloc(0)` would drop that data.

```javascript
const httpServer = http.createServer((req, res) => { /* existing HTTP logic */ });
httpServer.on('upgrade', (req, socket, head) => {
  handleWebSocketUpgrade(req, socket, head, tunnels);
});
```

**Step 1.3 — Implement handleWebSocketUpgrade (accept upgrade immediately)**

To avoid a race where the local server sends frames before the VPS has accepted the upgrade — those frames would arrive with nowhere to go and be dropped — **accept the upgrade on the VPS first**:

- Extract subdomain, look up tunnel WebSocket
- Generate `connectionId`
- Call `wssPublic.handleUpgrade(req, socket, head, (ws) => { ... })` immediately — the public WebSocket is now open
- Put the public WebSocket in a "pending" or "connecting" state; buffer any frames it receives until `ws-connect-response` arrives
- Send `ws-connect` to tunnel client; set `path` to `req.url` (includes query string, e.g., `/ws?token=abc123`)
- Set timeout (e.g., 10s) — if no response: remove from pending map, close the public WebSocket, and send `ws-close` to the client so it tears down any orphaned local WebSocket

**Step 1.4 — Handle ws-connect-response**

- Look up pending public WebSocket by connectionId
- If status 101: mark connection as established; flush any buffered frames from the public client to the tunnel; wire up frame/close handlers
- If status != 101 (e.g., local server down, connection refused): close the public WebSocket with 1011 and a descriptive reason (e.g., "Local server unavailable") so the browser client gets actionable feedback

> **Buffer flush order:** The server flushes first; those frames arrive at the client and go into the client's buffer; the client flushes when the local WebSocket opens. The double-buffer is intentional — ordering is preserved because the control channel is a single ordered WebSocket.

**Step 1.5 — Frame relay (server → client)**

When public WebSocket receives a message or closes:
- `ws.on('message', (data, isBinary) => { send ws-frame to tunnel })` — if still pending, buffer instead of sending until ws-connect-response confirms
- `ws.on('close', (code, reason) => { send ws-close to tunnel; remove from map })` — use `reason.toString()` when constructing the message; the `ws` library passes `reason` as a Buffer
- **Handle public client disconnect while pending:** If the public client disconnects before `ws-connect-response` arrives, the pending WebSocket fires `close`. Send `ws-close` to the client so the local WebSocket (if it connected) gets torn down.

**Step 1.6 — Frame relay (client → server)**

When tunnel receives `ws-frame` or `ws-close`:
- Look up public WebSocket by connectionId
- For `ws-frame`: Check `readyState === WebSocket.OPEN` before sending, or wrap in try/catch — a `ws-frame` can arrive just as the socket is closing, and `.send()` on a closing/closed WebSocket throws. If send fails, send `ws-close` to the client to clean up.
- For `ws-close`: `publicWs.close(code, reason)`; remove from map

**Step 1.7 — Cleanup on tunnel disconnect**

In the tunnel's `close` handler, iterate `tunnelRequests` (or a new `tunnelWebSockets`) and close all public WebSockets for that subdomain.

### Phase 2: Client-Side WebSocket Handling

**Step 2.1 — Handle ws-connect**

When `msg.type === 'ws-connect'`:
- Build URL: `ws://localhost:${LOCAL_PORT}${msg.path}` — `path` includes the query string when present (e.g., `/ws?token=abc123`); the server sends `req.url` from the upgrade request
- Build headers: copy from `msg.headers`, rewrite `Host` to `localhost:PORT` if `rewriteHost`
- Create `new WebSocket(url, { headers })`

**Step 2.2 — Send ws-connect-response**

- On `open`: Send status 101 with headers (or minimal headers if the `ws` library doesn't expose the server's response headers directly). The VPS has already accepted the upgrade; this confirms the local side is ready.
- On `error` or connection failure: Send status 502 with error message
- On HTTP error response (e.g., 404 from local server): The `ws` library may emit `error` with the upgrade response. Capture status and headers from the error if possible, or send 502.

**Step 2.3 — Frame relay**

- `localWs.on('message', (data, isBinary) => { send ws-frame to tunnel with isBinary })`
- When receiving `ws-frame` from tunnel: Check `readyState === WebSocket.OPEN` before calling `localWs.send(data, { binary: msg.isBinary })`, or wrap in try/catch — the socket may be closing. If send fails, send `ws-close` to the server.
- **Buffer incoming ws-frames** until the local WebSocket is open — frames from the public client can arrive before the local connection is established. Flush the buffer when the local WebSocket `open` event fires.

**Step 2.4 — Close handling**

- `localWs.on('close', (code, reason) => { send ws-close to tunnel })` — use `reason.toString()` when constructing the message; the `ws` library passes `reason` as a Buffer
- When receiving `ws-close` from tunnel: `localWs.close(code, reason)`

**Step 2.5 — Connection map**

Maintain `Map<connectionId, WebSocket>` to route incoming `ws-frame` and `ws-close` to the correct local WebSocket.

### Phase 3: Edge Cases & Robustness

**Step 3.1 — Host header rewriting**

For WebSocket connections, the local server may validate the Host header. Use the same `rewriteHost` logic as HTTP: rewrite to `localhost:PORT` by default.

**Step 3.2 — Subprotocols and extensions**

The WebSocket handshake may include `Sec-WebSocket-Protocol` and `Sec-WebSocket-Extensions`. Forward these headers in `ws-connect`. **Limitation:** Because we accept the upgrade on the VPS before the local handshake completes, the VPS responds to the browser without knowing which subprotocol the local server will choose. The browser's negotiated subprotocol may not match the local server's. For most dev use cases this won't matter; apps that require specific subprotocol negotiation may not work correctly.

**Step 3.3 — Connection limits**

Consider a max number of concurrent WebSocket connections per tunnel (e.g., 50) to prevent memory exhaustion. Reject new upgrades with 503 if over limit.

**Step 3.4 — Graceful shutdown**

On SIGTERM, close all public WebSocket connections with a close code indicating shutdown (e.g., 1011) so clients can reconnect.

**Step 3.5 — Logging connectionId**

Log `connectionId` on both server and client for lifecycle events (opened, established, closed with code). WebSocket connections can live for hours; having connectionId in logs alongside frame counts and close reasons is invaluable for debugging. HTTP tunneling has requestId in logs; WebSocket tunneling should have the same visibility.

---

## 6. Known Limitations (Accepted Trade-offs)

| Feature | Current Approach | Notes |
|---------|-----------------|-------|
| **Frame encoding** | Base64 in JSON | Same as HTTP bodies; ~33% overhead. The real cost is CPU (encode/decode per frame). Future upgrade path: binary WebSocket frames on the control channel with a small header (e.g., 1-byte type + 16-byte connectionId) instead of JSON for `ws-frame`, skipping Base64 entirely. |
| **JSON parse/stringify** | One JSON object per frame | High-throughput WebSockets (e.g., 60 fps games) force constant JSON.parse/stringify on the event loop. Keep JSON for V1 — easier to debug. If optimizing for high throughput later, switch to a custom binary protocol instead. |
| **Per-message-deflate** | Pass through | If both ends support it, it will work. We're not compressing; we're just relaying. |
| **Very high WebSocket traffic** | Single control WebSocket | All frames multiplex over one connection; head-of-line blocking possible. Acceptable for personal use. |
| **Concurrent WebSockets** | Multiple per tunnel | Each gets a connectionId; no limit in initial implementation beyond memory. |
| **Subprotocol negotiation** | VPS accepts before local handshake | Browser's negotiated subprotocol may not match local server's choice. Fine for most dev use; may break apps that require specific subprotocols. |
| **Control channel backpressure** | None in V1 | If the local server is a fast producer (e.g., streaming sensor data), ws-frame messages can pile up on the control WebSocket faster than the public client consumes them. Unbounded buffering can crash the process. The `ws` library exposes `ws.bufferedAmount`; a future V2 could pause the local WebSocket when the control channel's buffer exceeds a threshold, then resume when it drains. |

---

## 7. Testing Strategy

1. **Unit test: upgrade handling** — Emit `upgrade` event with mock req/socket/head; verify server sends `ws-connect` and doesn't treat as HTTP.
2. **Integration test: echo server** — Run a local WebSocket echo server (e.g., `ws` package with echo behavior). Connect from browser via tunnel URL. Send message; verify echo.
3. **Integration test: app with both** — Use a real app (e.g., a chat app) that serves HTTP for the page and WebSocket for real-time updates. Load page via tunnel; verify WebSocket connects.
4. **Disconnect test** — Kill tunnel client; verify public WebSocket receives close and cleanup.

---

## 8. Recommended Build Order

1. **Server: upgrade handling and immediate accept** — Listen on `server.on('upgrade')`, accept immediately on the VPS, then send `ws-connect` to the client. Buffer frames from the public client until `ws-connect-response`. No client changes yet; the client will ignore unknown message types. On timeout: close public WebSocket, send `ws-close` to client.
2. **Client: ws-connect handler** — Implement client-side handling: connect to localhost, send `ws-connect-response`. Buffer incoming `ws-frame` messages until the local WebSocket is open. Use a simple local WebSocket server (e.g., `ws` echo example) to test.
3. **Server: handle ws-connect-response** — On success, flush buffered frames; on failure, close the public WebSocket with 1011.
4. **Bidirectional frame relay** — Implement `ws-frame` and `ws-close` in both directions.
5. **Cleanup and edge cases** — Tunnel disconnect, graceful shutdown, connection limits.
6. **Integration test with real app** — Point at an app that uses WebSockets (e.g., hot-dice, multi-mouse, or a simple chat).

---

## 9. Change Log

| Version | Changes |
|---------|---------|
| v1 | Initial design — protocol extension (ws-connect, ws-connect-response, ws-frame, ws-close), architecture changes, implementation plan with accept-then-buffer strategy |
| v2 | Reversed handshake to accept upgrade immediately on VPS to fix dropped-frame race (local server can send frames before VPS accepted); added buffering on VPS for frames from public client until ws-connect-response; added buffering on client for incoming ws-frames until local WebSocket open; changed ws-frame schema from opcode to isBinary to match Node.js ws API message event; added JSON parse/stringify overhead to Known Limitations; added control WebSocket heartbeat note in Prerequisites |
| v3 | Aligned section names with main tunnel plan (Useful References, Known Limitations (Accepted Trade-offs)); component names (The Tunnel Server, The Local Client); Key Insight as blockquote |
| v4 | Switched from request handler to server.on('upgrade') for WebSocket handling — upgrade event provides head buffer, request handler may not fire; added readyState check or try/catch before .send() on both server and client (sending to closing/closed socket throws); timeout cleanup now sends ws-close to client to tear down orphaned local WebSocket; clarified ws-connect-response 101 as "local side ready" signal never sent to browser; added descriptive close reason ("Local server unavailable") on 502 path; handle public client disconnect while pending — send ws-close so local WebSocket tears down; added subprotocol negotiation limitation; added binary upgrade path note to Frame encoding limitation |
| v5 | ws-connect path now includes query string (use req.url) — many apps pass auth tokens or room IDs via query params; added sec-websocket-protocol to ws-connect schema example; added control channel backpressure to Known Limitations (unbounded buffering can crash process; ws.bufferedAmount for future V2); added buffer flush order note in Step 1.4 (double-buffer intentional, ordering preserved by single ordered control channel); use reason.toString() when constructing ws-close in Step 1.5 and Step 2.4 — ws library passes reason as Buffer; added Step 3.5 for connectionId logging on lifecycle events |

---

## 10. Useful References

- WebSocket spec (RFC 6455): [datatracker.ietf.org/doc/html/rfc6455](https://datatracker.ietf.org/doc/html/rfc6455)
- Node.js `ws` library: [github.com/websockets/ws](https://github.com/websockets/ws)
- Base tunnel plan: `tunnel-service-plan.md`

---

*End of Document*
