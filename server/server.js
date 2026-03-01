const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

const TUNNEL_SECRET = process.env.TUNNEL_SECRET;
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

if (!TUNNEL_SECRET) {
  console.error("FATAL: TUNNEL_SECRET environment variable is required");
  process.exit(1);
}

const tunnels = new Map(); // subdomain -> ws
const pendingRequests = new Map(); // requestId -> { res, timer, subdomain }
const tunnelRequests = new Map(); // subdomain -> Set<requestId>

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateSubdomain() {
  let subdomain;
  do {
    subdomain = crypto.randomBytes(4).toString("hex");
  } while (tunnels.has(subdomain));
  return subdomain;
}

const controlServer = new WebSocket.Server({
  port: 4001,
  maxPayload: 16 * 1024 * 1024,
});

controlServer.on("connection", (ws) => {
  let authenticated = false;
  let subdomain = null;

  const authTimeout = setTimeout(() => {
    if (!authenticated) ws.close(1008, "Authentication timeout");
  }, 5000);

  ws.on("message", (data) => {
    if (!authenticated) clearTimeout(authTimeout);

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      ws.close(1003, "Invalid message format");
      return;
    }

    if (!authenticated) {
      if (msg.type !== "auth" || !constantTimeEqual(msg.token, TUNNEL_SECRET)) {
        ws.close(1008, "Unauthorized");
        return;
      }

      const requested = msg.subdomain;
      if (requested !== undefined) {
        if (!SUBDOMAIN_REGEX.test(requested)) {
          ws.close(1008, `Invalid subdomain. Must match: ${SUBDOMAIN_REGEX}`);
          return;
        }
        if (tunnels.has(requested)) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Subdomain '${requested}' is already in use.`,
            })
          );
          ws.close(1008, "Subdomain in use");
          return;
        }
        subdomain = requested;
      } else {
        subdomain = generateSubdomain();
      }

      authenticated = true;
      tunnels.set(subdomain, ws);
      tunnelRequests.set(subdomain, new Set());

      ws.send(JSON.stringify({ type: "registered", subdomain }));
      console.log(`[+] Tunnel registered: ${subdomain}`);

      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });

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

      ws.on("close", () => {
        clearInterval(heartbeat);
        tunnels.delete(subdomain);

        const reqIds = tunnelRequests.get(subdomain) || new Set();
        for (const requestId of reqIds) {
          const pending = pendingRequests.get(requestId);
          if (!pending) continue;
          clearTimeout(pending.timer);
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { "Content-Type": "text/plain" });
            pending.res.end("Tunnel client disconnected");
          }
          pendingRequests.delete(requestId);
        }

        tunnelRequests.delete(subdomain);
        console.log(`[-] Tunnel closed: ${subdomain}`);
      });

      return;
    }

    if (msg.type === "response") {
      const pending = pendingRequests.get(msg.requestId);
      if (!pending) return;

      clearTimeout(pending.timer);
      pendingRequests.delete(msg.requestId);
      tunnelRequests.get(subdomain)?.delete(msg.requestId);

      const decodedBody = Buffer.from(msg.body || "", "base64");
      const headers = { ...msg.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      delete headers["connection"];
      delete headers["keep-alive"];

      if (msg.status === 204) {
        pending.res.writeHead(msg.status, headers);
        pending.res.end();
      } else {
        if (!headers["content-length"]) {
          headers["content-length"] = decodedBody.length;
        }
        pending.res.writeHead(msg.status, headers);
        pending.res.end(decodedBody);
      }
    }
  });
});

const publicServer = http.createServer((req, res) => {
  if (req.url === "/_tunnel_health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  res.setHeader("Connection", "close");

  const host = req.headers.host || "";
  const subdomain = host.split(".")[0];
  const ws = tunnels.get(subdomain);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Tunnel not found or not connected");
    return;
  }

  const requestId = crypto.randomUUID();
  const bodyChunks = [];
  let totalSize = 0;
  let aborted = false;

  console.log(`[→] ${req.method} ${host}${req.url}`);

  req.on("data", (chunk) => {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload too large (max 10MB)");
      req.destroy();
      return;
    }
    bodyChunks.push(chunk);
  });

  req.on("error", (err) => {
    console.error("Public request error:", err.message);
    if (!res.headersSent) {
      res.statusCode = 400;
      res.end();
    }
  });

  req.on("end", () => {
    if (aborted) return;

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      tunnelRequests.get(subdomain)?.delete(requestId);
      if (res.headersSent) return;
      res.writeHead(504, { "Content-Type": "text/plain" });
      res.end("Gateway Timeout: local server did not respond in time");
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { res, timer, subdomain });
    tunnelRequests.get(subdomain)?.add(requestId);

    try {
      ws.send(
        JSON.stringify({
          type: "request",
          requestId,
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: Buffer.concat(bodyChunks).toString("base64"),
        })
      );
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      tunnelRequests.get(subdomain)?.delete(requestId);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Tunnel connection lost");
    }
  });
});

function gracefulShutdown() {
  console.log("Shutdown signal received, draining in-flight requests...");

  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    if (!pending.res.headersSent) {
      try {
        pending.res.writeHead(503, {
          "Content-Type": "text/plain",
          "Retry-After": "5",
        });
        pending.res.end("Service temporarily unavailable - server restarting");
      } catch {}
    }
    pendingRequests.delete(requestId);
  }

  for (const [, ws] of tunnels) {
    try {
      ws.send(
        JSON.stringify({
          type: "shutdown",
          message: "Server restarting, please reconnect",
        })
      );
    } catch {}
  }

  setTimeout(() => {
    publicServer.close();
    controlServer.close();
    process.exit(0);
  }, 2000);
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

publicServer.listen(4000, () => {
  console.log("Public proxy listening on :4000");
});
console.log("Control server listening on :4001 (proxied via nginx /tunnel-control)");
