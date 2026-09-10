// Sponsor auth, lifted from
// `../f1-live-events-poc/poc/live-recorder/recorder.ts`. AGENTS.md: "The
// sponsor bearer token expires in 3600 s: refresh before expiry and on every
// reconnect." OPENF1_LOGIN/OPENF1_PASSWORD unset -> unauthenticated fallback
// (historical use only; live will 401 — see apps/ingest/AGENTS.md "free tier
// locks out during any live session").

import type { Fetcher, RawRecord } from "./types.js";

export interface Credentials {
  login: string;
  password: string;
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const login = env["OPENF1_LOGIN"];
  const password = env["OPENF1_PASSWORD"];
  return login && password ? { login, password } : null;
}

const TOKEN_URL = "https://api.openf1.org/token";
// Refresh 2 min before expiry.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export type FetchLike = typeof fetch;

interface TokenResponse {
  access_token: string;
  expires_in: unknown;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RawRecord)["access_token"] === "string"
  );
}

// Fact, measured 2026-09-09 from inside the ingest container against the
// real endpoint (POST https://api.openf1.org/token, form-encoded
// username/password): status 200, content-type: application/json, body
// shape {"expires_in":"3600","access_token":"<912 chars>","token_type":
// "bearer"}. expires_in is a STRING. Parse leniently and fall back to
// 3600s when it's missing or not a finite positive number.
function parseExpiresInSeconds(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.error(`token: expires_in missing or invalid (${String(value)}), assuming 3600 s`);
  return 3600;
}

/**
 * Acquires and refreshes the OpenF1 sponsor bearer token. `getToken()`
 * returns `null` (never throws) when no credentials are configured, so
 * callers fall back to unauthenticated requests.
 */
export class OpenF1Auth {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  public constructor(
    private readonly creds: Credentials | null,
    opts: { fetchImpl?: FetchLike; now?: () => number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  public async getToken(): Promise<string | null> {
    if (this.creds === null) return null;
    const nowMs = this.now();
    if (this.token !== null && nowMs < this.expiresAt - REFRESH_MARGIN_MS) return this.token;
    return this.refresh(this.creds);
  }

  /** Force the next `getToken()` to refresh (e.g. after a 401/403). */
  public invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async refresh(creds: Credentials): Promise<string> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ username: creds.login, password: creds.password }),
    });
    if (!response.ok) throw new Error(`OpenF1 token endpoint ${response.status}`);
    const data: unknown = await response.json();
    if (!isTokenResponse(data)) {
      throw new Error("OpenF1 token endpoint: unexpected response shape");
    }
    this.token = data.access_token;
    this.expiresAt = this.now() + parseExpiresInSeconds(data.expires_in) * 1000;
    return this.token;
  }
}

/**
 * Wraps `fetch` with the bearer token (when configured), retries once on
 * 401/403 with a fresh token, and treats 404 as "no data yet" — a fact, not
 * an error (apps/ingest/AGENTS.md: "The live API rejects all date filters; a
 * 404 there means no data yet, not an error.").
 */
export function createOpenF1Fetcher(auth: OpenF1Auth, opts: { fetchImpl?: FetchLike } = {}): Fetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (url: string): Promise<unknown> => {
    const token = await auth.getToken();
    let response = await fetchImpl(url, { headers: authHeader(token) });
    if ((response.status === 401 || response.status === 403) && token !== null) {
      auth.invalidate();
      const fresh = await auth.getToken();
      response = await fetchImpl(url, { headers: authHeader(fresh) });
    }
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`OpenF1 ${response.status} for ${url}`);
    return response.json();
  };
}

function authHeader(token: string | null): Record<string, string> {
  return token !== null ? { authorization: `Bearer ${token}` } : {};
}
