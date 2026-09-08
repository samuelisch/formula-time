// One place that knows where the api lives (ADR-0008). `VITE_API_URL` is
// the api origin baked in at build time on the static host; unset in dev,
// where the Vite proxy makes the api same-origin.
const base: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export function apiUrl(path: string): string {
  return `${base}${path}`;
}

/** Cross-origin fetch that still carries the viewer cookie. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), { credentials: "include", ...init });
}
