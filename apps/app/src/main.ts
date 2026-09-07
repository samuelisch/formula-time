// App service: projector (the authority), poll module, serialize-once
// SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import Fastify from "fastify";
import { SHARED_PACKAGE } from "@formula-time/shared";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, shared: SHARED_PACKAGE }));

await app.listen({ port, host: "0.0.0.0" });
