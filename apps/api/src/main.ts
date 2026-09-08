// API service — the "app service" of ADR-0001: projector (the authority), poll module,
// serialize-once SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import Fastify from "fastify";
import { DOMAIN_PACKAGE } from "@formula-time/domain";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, domain: DOMAIN_PACKAGE }));

// Placeholder for the fan-out (ADR-0001 §1): hand-written on the raw
// response because compression middleware would gzip per viewer (ADR-0002).
// Will be replaced by the projector's serialize-once push.
app.get("/live/events", (request, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = () => res.write(`event: heartbeat\ndata: {"t":${Date.now()}}\n\n`);
  send();
  const timer = setInterval(send, 5000);
  request.raw.on("close", () => clearInterval(timer));
});

await app.listen({ port, host: "0.0.0.0" });
