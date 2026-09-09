// The serialize-once SSE fan-out (ADR-0001 §1 invariant 1, HLD §7 "Push"):
// one JSON.stringify per push, gzip once as an independent full-flushed
// block, identical bytes to every socket. A vote never triggers a push --
// this class has no idea votes exist; it only ever sends what it is told to.
//
// Delta pushes (ADR-<N> "Delta pushes", issue #89): sockets are tagged with
// a `format` in addition to `encoding`. A `state`-format socket gets the
// full push every tick, unchanged. A `delta`-format socket gets one `state`
// push at join (ADR point 2), then a `delta` push each tick -- a
// hand-written JSON Patch (patch.ts) from the previous pushed RaceState to
// this one -- except every KEYFRAME_INTERVAL-th push, which is a full
// `state` push instead (ADR point 5, recovery without a client fetch). Per
// tick this class serialises once per format it actually has sockets for
// (ADR point 4): the `state` frame always (joins and `GET
// /api/live/snapshot` need it even with zero legacy sockets attached), plus
// the `delta` frame only when a delta socket is attached and this is not a
// keyframe tick.
import type { ServerResponse } from "node:http";
import { constants as zlibConstants, createDeflateRaw, type DeflateRaw } from "node:zlib";

import type { RaceState } from "@formula-time/domain";

import { diffState } from "./patch.js";

export type Encoding = "gzip" | "plain";
export type Format = "state" | "delta";
export type FanoutLog = (msg: string, fields?: Record<string, unknown>) => void;

/** The shape `push()` needs to build a delta -- a structural subset of the
 * real `{ type: "state", ... }` payload session-lifecycle.ts sends. `push`
 * itself stays typed as `object` (existing callers, and tests, push
 * arbitrary shapes when they only exercise state-format delivery).
 *
 * `events`/`rebuilt` (issue #114): carried through to the delta frame
 * exactly like `polls` already is, unvalidated by `isStateLike` -- neither
 * is used to decide whether a payload is state-like, only read once it is. */
interface StateLike {
  seq: unknown;
  sent_at: unknown;
  session_key: unknown;
  state: unknown;
  polls: unknown;
  events: unknown;
  rebuilt?: unknown;
}

function isStateLike(payload: object): payload is StateLike {
  const record = payload as Partial<StateLike>;
  return (
    record.seq !== undefined &&
    record.sent_at !== undefined &&
    record.session_key !== undefined &&
    record.state !== undefined
  );
}

interface Socket {
  res: ServerResponse;
  encoding: Encoding;
  format: Format;
}

interface Frame {
  plain: Buffer;
  gz: Buffer;
}

// The 10-byte gzip header (brief, verbatim): magic (0x1f 0x8b), deflate
// method (0x08), no flags, zero mtime, no extra flags, OS unknown (0x03).
// No trailer is ever sent -- the stream ends when the socket closes.
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

const MAX_WRITABLE_LENGTH = 1_048_576;
const HEARTBEAT_MS = 5000;
const HEARTBEAT_FRAME = Buffer.from(": heartbeat\n\n");
const CATCHING_UP_FRAME = Buffer.from('event: status\ndata: {"catching_up":true}\n\n');
// ADR point 5: every 200th push to delta sockets is a full `state` push
// instead of a delta -- recovery within ~50s at the projector's ~4
// pushes/s tick rate, with no client fetch.
const KEYFRAME_INTERVAL = 200;

export class Fanout {
  private readonly log: FanoutLog;
  private readonly sockets = new Set<Socket>();
  private readonly deflater: DeflateRaw = createDeflateRaw();

  // Every call that feeds the shared deflater (a push, a join's catching-up
  // frame, a heartbeat) is chained through this promise so only one write +
  // full-flush is ever in flight -- the deflater is one stateful stream.
  private deflateChain: Promise<unknown> = Promise.resolve();

  // `latest` per format (ADR point 5's implementation note): the state
  // frame is always kept (joins of either format, and the snapshot route,
  // read it); the delta frame is kept too, for symmetry, though nothing
  // reads it back today -- joins always bootstrap from `latestState` per
  // ADR point 2, never from `latestDelta`.
  private latestState: Frame | null = null;
  private latestStateJson: string | null = null;
  private latestDelta: Frame | null = null;

  // The RaceState (and its seq) actually delivered by the last push --
  // "the previous pushed RaceState is kept for the diff" (issue #89). Never
  // patched in place; each push diffs against exactly this.
  private prevState: RaceState | null = null;
  private prevSeq: string | null = null;
  private deltaPushCount = 0;

  // Maintained incrementally in join()/remove() rather than scanned from
  // `this.sockets` on every push (review round 1, PR #109): a per-tick scan
  // over every socket just to answer "is any delta socket attached" would
  // scale with viewer count, contrary to invariant 1 ("never per-viewer
  // server work") -- the whole point of keeping this a plain counter.
  private deltaSocketCount = 0;

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

  /** Write the gzip header (if gzip) then the newest existing frame, then
   * attach. Every join -- `state` or `delta` format alike -- gets the
   * newest `state` push, never `latestDelta` (ADR point 2: "Every live join
   * is the same"); a delta socket's subsequent pushes are deltas. A socket
   * joining before any push at all gets the `catching_up` status frame,
   * regardless of format, same as today. */
  public async join(res: ServerResponse, encoding: Encoding, format: Format = "state"): Promise<void> {
    if (encoding === "gzip") {
      res.write(GZIP_HEADER);
    }

    if (this.latestState !== null) {
      res.write(encoding === "gzip" ? this.latestState.gz : this.latestState.plain);
    } else {
      const gz = encoding === "gzip" ? await this.deflate(CATCHING_UP_FRAME) : null;
      res.write(encoding === "gzip" ? (gz as Buffer) : CATCHING_UP_FRAME);
    }

    this.sockets.add({ res, encoding, format });
    if (format === "delta") {
      this.deltaSocketCount += 1;
    }
  }

  /** `GET /api/live/snapshot`: the newest `state` push's JSON, verbatim --
   * "same bytes the fan-out holds" (issue #89). `null` before the first
   * push (the route answers 503). */
  public snapshotJson(): string | null {
    return this.latestStateJson;
  }

  public remove(res: ServerResponse): void {
    for (const socket of this.sockets) {
      if (socket.res === res) {
        this.sockets.delete(socket);
        if (socket.format === "delta") {
          this.deltaSocketCount -= 1;
        }
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
    // Format-agnostic: the heartbeat is a comment frame, not a push: every
    // socket gets the same bytes regardless of `format`.
    this.writeFixed(HEARTBEAT_FRAME, gz);
    this.lastActivityAt = Date.now();
  }

  private async deliver(payload: object): Promise<void> {
    const json = JSON.stringify(payload);
    const statePlain = Buffer.from(`event: state\ndata: ${json}\n\n`);
    const stateGz = await this.deflate(statePlain);
    const stateFrame: Frame = { plain: statePlain, gz: stateGz };
    this.latestState = stateFrame;
    this.latestStateJson = json;

    const deltaFrame = await this.buildDeltaFrame(payload);
    this.latestDelta = deltaFrame ?? stateFrame;

    this.writePush(stateFrame, this.latestDelta);
    this.lastActivityAt = Date.now();

    if (isStateLike(payload)) {
      this.prevState = payload.state as RaceState;
      this.prevSeq = String(payload.seq);
    }
  }

  /** `null` means "send the state frame instead" -- a keyframe tick, no
   * delta socket attached, no previous state to diff against yet, or (the
   * failure path) diffState threw for this tick, logged once here. */
  private async buildDeltaFrame(payload: object): Promise<Frame | null> {
    if (this.deltaSocketCount === 0) {
      return null;
    }

    this.deltaPushCount += 1;
    const isKeyframe = this.deltaPushCount % KEYFRAME_INTERVAL === 0;
    if (isKeyframe || this.prevState === null || this.prevSeq === null || !isStateLike(payload)) {
      return null;
    }

    try {
      const patch = diffState(this.prevState, payload.state as RaceState);
      const deltaPayload = {
        type: "delta",
        seq: payload.seq,
        base_seq: this.prevSeq,
        sent_at: payload.sent_at,
        session_key: payload.session_key,
        patch,
        polls: payload.polls,
        // Issue #114: straight through from the source payload, same as
        // `polls` above -- `events` is the RaceEvent rows the tick applied
        // (a client folds these into its timeline regardless of format);
        // `rebuilt` is `undefined` on an ordinary tick, which
        // `JSON.stringify` omits from the wire entirely, so a delta client
        // only ever sees the key when a rebuild produced this push.
        events: payload.events,
        rebuilt: payload.rebuilt,
      };
      const plain = Buffer.from(`event: delta\ndata: ${JSON.stringify(deltaPayload)}\n\n`);
      const gz = await this.deflate(plain);
      return { plain, gz };
    } catch (err) {
      this.log("delta diff failed, falling back to a state push for this tick", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** The heartbeat: format-agnostic, the same bytes to every socket. */
  private writeFixed(plain: Buffer, gz: Buffer): void {
    this.write((socket) => (socket.encoding === "gzip" ? gz : plain));
  }

  /** A push: `state`-format sockets get `stateFrame`, `delta`-format
   * sockets get `deltaFrame` -- byte-identical within a format, per socket
   * encoding. */
  private writePush(stateFrame: Frame, deltaFrame: Frame): void {
    this.write((socket) => {
      const frame = socket.format === "delta" ? deltaFrame : stateFrame;
      return socket.encoding === "gzip" ? frame.gz : frame.plain;
    });
  }

  private write(pick: (socket: Socket) => Buffer): void {
    let dropped = 0;
    for (const socket of this.sockets) {
      socket.res.write(pick(socket));
      if (socket.res.writableLength > MAX_WRITABLE_LENGTH) {
        socket.res.destroy();
        this.sockets.delete(socket);
        if (socket.format === "delta") {
          this.deltaSocketCount -= 1;
        }
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
