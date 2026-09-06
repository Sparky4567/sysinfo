import dashboard from "./index.html";
import { collectSnapshot } from "./stats";

const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 1000;

let lastSnapshot: Awaited<ReturnType<typeof collectSnapshot>> | null = null;
let collecting = false;

async function snapshot() {
  if (collecting && lastSnapshot) return lastSnapshot;
  collecting = true;
  try {
    lastSnapshot = await collectSnapshot();
    return lastSnapshot;
  } catch (err) {
    console.error("collectSnapshot failed:", err);
    if (lastSnapshot) return lastSnapshot;
    throw err;
  } finally {
    collecting = false;
  }
}

// Prime cache so first WS/HTTP hit is instant
snapshot().catch(() => {});

const server = Bun.serve({
  port: PORT,

  routes: {
    "/": dashboard,
    "/api/stats": {
      async GET() {
        try {
          const data = await snapshot();
          return Response.json(data);
        } catch {
          return Response.json({ error: "failed to collect stats" }, { status: 500 });
        }
      },
    },
    "/health": {
      GET: () => Response.json({ ok: true, ts: Date.now() }),
    },
  },

  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/realtime") {
      const ok = srv.upgrade(req);
      if (ok) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      ws.subscribe("stats");
      // Push an immediate frame so the UI paints without waiting a tick
      snapshot()
        .then((data) => {
          try {
            ws.send(JSON.stringify({ type: "stats", data }));
          } catch {}
        })
        .catch(() => {});
    },
    message() {
      // client -> server messages ignored (could support set-interval later)
    },
    close(ws) {
      try {
        ws.unsubscribe("stats");
      } catch {}
    },
  },
});

// Broadcast loop — single sampler fans out to all WS clients
setInterval(async () => {
  try {
    const data = await snapshot();
    server.publish("stats", JSON.stringify({ type: "stats", data }));
  } catch (err) {
    console.error("broadcast failed:", err);
  }
}, TICK_MS);

console.log(`sysinfo dashboard → http://localhost:${server.port}/`);
console.log(`REST snapshot      → http://localhost:${server.port}/api/stats`);
console.log(`WebSocket stream   → ws://localhost:${server.port}/realtime`);
