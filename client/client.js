const WebSocket = require("ws");
const http = require("http");

const args = process.argv.slice(2);
const LOCAL_PORT = Number.parseInt(args[0], 10) || 3000;

const subdomainFlagIndex = args.indexOf("--subdomain");
const requestedSubdomain =
  subdomainFlagIndex !== -1 ? args[subdomainFlagIndex + 1] : undefined;
const rewriteHost = !args.includes("--no-rewrite-host");

const TUNNEL_HOST = process.env.TUNNEL_HOST;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

if (!TUNNEL_HOST) {
  console.error("FATAL: TUNNEL_HOST environment variable is required");
  process.exit(1);
}

if (!TUNNEL_SECRET) {
  console.error("FATAL: TUNNEL_SECRET environment variable is required");
  process.exit(1);
}

let retryDelay = 1000;
const MAX_RETRY_DELAY = 30_000;

function connect() {
  console.log(`Connecting to ${TUNNEL_HOST}...`);
  const ws = new WebSocket(`wss://${TUNNEL_HOST}/tunnel-control`);

  ws.on("open", () => {
    const authMsg = {
      type: "auth",
      token: TUNNEL_SECRET,
    };
    if (requestedSubdomain) authMsg.subdomain = requestedSubdomain;

    ws.send(JSON.stringify(authMsg));
    retryDelay = 1000;
  });

  ws.on("ping", () => ws.pong());

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      console.error("Received malformed message from server");
      return;
    }

    if (msg.type === "registered") {
      console.log(`\nTunnel active: https://${msg.subdomain}.${TUNNEL_HOST}\n`);
      return;
    }

    if (msg.type === "error") {
      console.error(`\nServer error: ${msg.message}`);
      return;
    }

    if (msg.type === "shutdown") {
      console.log(`\nServer restarting: ${msg.message}`);
      ws.close();
      return;
    }

    if (msg.type !== "request") return;

    if (!msg.requestId) {
      console.error("Received request without requestId. Ignoring.");
      return;
    }

    const headers = { ...(msg.headers || {}) };
    if (rewriteHost) headers.host = `localhost:${LOCAL_PORT}`;

    const options = {
      hostname: "localhost",
      port: LOCAL_PORT,
      path: msg.path,
      method: msg.method,
      headers,
    };

    const localReq = http.request(options, (localRes) => {
      const chunks = [];
      localRes.on("data", (chunk) => chunks.push(chunk));
      localRes.on("end", () => {
        const body = Buffer.concat(chunks);
        const responseHeaders = { ...localRes.headers };

        if (msg.method !== "HEAD") {
          delete responseHeaders["content-length"];
        }
        delete responseHeaders.connection;
        delete responseHeaders["keep-alive"];
        delete responseHeaders["transfer-encoding"];

        try {
          ws.send(
            JSON.stringify({
              type: "response",
              requestId: msg.requestId,
              status: localRes.statusCode || 500,
              headers: responseHeaders,
              body: body.toString("base64"),
            })
          );
        } catch (err) {
          console.error("Failed to send response - tunnel dropped:", err.message);
        }
      });
    });

    localReq.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        console.error(
          `Local server refused connection on localhost:${LOCAL_PORT}. Is it running?`
        );
      } else {
        console.error(`Local server error: ${err.message}`);
      }

      try {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            status: 502,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("Bad Gateway: local server unreachable").toString(
              "base64"
            ),
          })
        );
      } catch (sendErr) {
        console.error(
          "Failed to send upstream error response - tunnel dropped:",
          sendErr.message
        );
      }
    });

    if (msg.body) {
      localReq.write(Buffer.from(msg.body, "base64"));
    }
    localReq.end();
  });

  ws.on("close", (code, reason) => {
    if (code === 1008) {
      console.error("\nConnection permanently rejected by server.");
      process.exit(1);
    }

    console.log(`\nConnection closed (${code}): ${reason.toString()}`);
    console.log(`Reconnecting in ${retryDelay / 1000}s...`);

    setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      connect();
    }, retryDelay);
  });

  ws.on("error", (err) => {
    console.error(`Connection error: ${err.message}`);
  });
}

connect();
