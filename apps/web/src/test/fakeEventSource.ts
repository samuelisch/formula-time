// A minimal EventSource stand-in for tests: only what useLiveStream.ts
// touches (addEventListener, close, onopen, onerror), plus helpers to
// drive it from a test.
type Listener = (event: MessageEvent<string>) => void;

export class FakeEventSource {
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed = false;

  private readonly listeners = new Map<string, Set<Listener>>();

  public addEventListener(name: string, listener: Listener): void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
  }

  public removeEventListener(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener);
  }

  public close(): void {
    this.closed = true;
  }

  /** Test helper: dispatch a named SSE event with the given data string. */
  public emit(name: string, data: string): void {
    const event = { data } as MessageEvent<string>;
    for (const listener of this.listeners.get(name) ?? []) {
      listener(event);
    }
  }

  /** Test helper: fire the connection's open handler. */
  public open(): void {
    this.onopen?.();
  }

  /** Test helper: fire the connection's error handler. */
  public fail(): void {
    this.onerror?.();
  }
}
