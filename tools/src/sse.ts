import type { IncomingMessage, ServerResponse } from "node:http";

export type SseEvent =
  | "report"
  | "probe-failed"
  | "agent-removed"
  | "sentiment"
  | "model-mismatch";

const clients = new Set<ServerResponse>();
let keepaliveTimer: NodeJS.Timeout | null = null;

export function addClient(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  // Listen for socket teardown on both request and response — reverse proxies
  // and abrupt disconnects don't always fire `res.close`.
  const remove = () => clients.delete(res);
  req.on("close", remove);
  req.on("error", remove);
  res.on("close", remove);
  res.on("error", remove);
  ensureKeepalive();
}

export function broadcast(type: SseEvent, data: unknown): void {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  // Snapshot to avoid mutation-during-iteration if write triggers a close.
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function ensureKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const res of [...clients]) {
      try { res.write(": ping\n\n"); } catch { clients.delete(res); }
    }
  }, 25000);
  keepaliveTimer.unref?.();
}

export function clientCount(): number { return clients.size; }
