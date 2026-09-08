// The serialize-once SSE fan-out (ADR-0001 §1 invariant 1, HLD §7 "Push"):
// one JSON.stringify per push, gzip once as an independent full-flushed
// block, identical bytes to every socket. A vote never triggers a push --
// this class has no idea votes exist; it only ever sends what it is told to.
import type { ServerResponse } from "node:http";
import { constants as zlibConstants, createDeflateRaw, type DeflateRaw } from "node:zlib";

export type Encoding = "gzip" | "plain";
export type FanoutLog = (msg: string, fields?: Record<string, unknown>) => void;

interface Socket {
  res: ServerResponse;
  encoding: Encoding;
}

// The 10-byte gzip header (brief, verbatim): magic (0x1f 0x8b), deflate
// method (0x08), no flags, zero mtime, no extra flags, OS unknown (0x03).
// No trailer is ever sent -- the stream ends when the socket closes.
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

const MAX_WRITABLE_LENGTH = 1_048_576;
const HEARTBEAT_MS = 5000;
const HEARTBEAT_FRAME = Buffer.from(": heartbeat\n\n");
const CATCHING_UP_FRAME = Buffer.from('event: status\ndata: {"catching_up":true}\n\n');

export class Fanout {
  private readonly log: FanoutLog;
  private readonly sockets = new Set<Socket>();
  private readonly deflater: DeflateRaw = createDeflateRaw();

  // Every call that feeds the shared deflater (a push, a join's catching-up
  // frame, a heartbeat) is chained through this promise so only one write +
  // full-flush is ever in flight -- the deflater is one stateful stream.
  private deflateChain: Promise<unknown> = Promise.resolve();

  private latest: { plain: Buffer; gz: Buffer } | null = null;
  private pushing = false;
  private pendingPayload: object | null = null;
  private hasPending = false;

  private lastActivityAt = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(opts: { log?: FanoutLog } = {}) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * Serialize once, gzip once, write the same bytes to every socket.
   * Pushes never overlap: if one is in flight, only the newest payload is
   * remembered and delivered next -- intermediate payloads are dropped.
   */
  public async push(payload: object): Promise<void> {
    this.pendingPayload = payload;
    this.hasPending = true;
    if (this.pushing) {
      return;
    }

    this.pushing = true;
    try {
      while (this.hasPending) {
        const next = this.pendingPayload as object;
        this.hasPending = false;
        this.pendingPayload = null;
        await this.deliver(next);
      }
    } finally {
      this.pushing = false;
    }
  }

  /** Write the gzip header (if gzip) then the newest existing frame, then attach. */
  public async join(res: ServerResponse, encoding: Encoding): Promise<void> {
    if (encoding === "gzip") {
      res.write(GZIP_HEADER);
    }

    if (this.latest !== null) {
      res.write(encoding === "gzip" ? this.latest.gz : this.latest.plain);
    } else {
      const gz = encoding === "gzip" ? await this.deflate(CATCHING_UP_FRAME) : null;
      res.write(encoding === "gzip" ? (gz as Buffer) : CATCHING_UP_FRAME);
    }

    this.sockets.add({ res, encoding });
  }

  public remove(res: ServerResponse): void {
    for (const socket of this.sockets) {
      if (socket.res === res) {
        this.sockets.delete(socket);
        return;
      }
    }
  }

  /** Every 5s with no push, send the heartbeat comment frame through the same path. */
  public heartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.maybeSendHeartbeat();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public size(): number {
    return this.sockets.size;
  }

  private async maybeSendHeartbeat(): Promise<void> {
    if (Date.now() - this.lastActivityAt < HEARTBEAT_MS) {
      return;
    }
    const gz = await this.deflate(HEARTBEAT_FRAME);
    this.writeToAll(HEARTBEAT_FRAME, gz);
    this.lastActivityAt = Date.now();
  }

  private async deliver(payload: object): Promise<void> {
    const json = JSON.stringify(payload);
    const plain = Buffer.from(`event: state\ndata: ${json}\n\n`);
    const gz = await this.deflate(plain);
    this.latest = { plain, gz };
    this.writeToAll(plain, gz);
    this.lastActivityAt = Date.now();
  }

  private writeToAll(plain: Buffer, gz: Buffer): void {
    let dropped = 0;
    for (const socket of this.sockets) {
      const buf = socket.encoding === "gzip" ? gz : plain;
      socket.res.write(buf);
      if (socket.res.writableLength > MAX_WRITABLE_LENGTH) {
        socket.res.destroy();
        this.sockets.delete(socket);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.log("slow client dropped", { count: dropped });
    }
  }

  /**
   * Writes `buf` then flushes with Z_FULL_FLUSH, resolving with exactly the
   * bytes emitted for that flush -- one independently decodable raw-deflate
   * block (brief: `zlib.inflateRawSync(block, { finishFlush: Z_SYNC_FLUSH })`
   * on any one block, alone, reproduces the plain frame it was made from).
   */
  private deflate(buf: Buffer): Promise<Buffer> {
    const result = this.deflateChain.then(() => this.deflateOnce(buf));
    this.deflateChain = result.catch(() => undefined);
    return result;
  }

  private deflateOnce(buf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
      };
      this.deflater.on("data", onData);
      this.deflater.write(buf, (writeErr) => {
        if (writeErr) {
          this.deflater.off("data", onData);
          reject(writeErr);
          return;
        }
        this.deflater.flush(zlibConstants.Z_FULL_FLUSH, () => {
          this.deflater.off("data", onData);
          resolve(Buffer.concat(chunks));
        });
      });
    });
  }
}
