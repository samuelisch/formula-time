// Lifted from the POC (poc/ts/viewer_identity.ts), unchanged in behaviour.
// The cookie value itself is computed here; it is set through Fastify's
// reply in routes.ts (`@fastify/cookie`), not by writing headers directly.
import { randomUUID } from "node:crypto";

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ViewerCookieOptions {
  path: string;
  maxAge: number;
  sameSite: "lax" | "none";
  httpOnly: boolean;
  secure: boolean;
}

// Split origins (ADR-0008, amended by ADR-0015) need SameSite=None so the
// cookie travels cross-origin between the Netlify bundle and the Railway
// api. A browser drops a SameSite=None cookie that is not Secure, and dev
// runs over plain http, so dev keeps SameSite=Lax and secure: false. This
// is the one place the attributes are decided: routes.ts passes the result
// straight to reply.setCookie, and resolveViewerId below formats the same
// values into its own raw fallback string, so the two can never drift.
export function viewerCookieOptions(env: string | undefined): ViewerCookieOptions {
  const production = env === "production";
  return {
    path: "/",
    maxAge: 31536000,
    sameSite: production ? "none" : "lax",
    httpOnly: true,
    secure: production,
  };
}

function formatSetCookie(viewerId: string, options: ViewerCookieOptions): string {
  const attrs = [
    `viewer_id=${viewerId}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite === "none" ? "None" : "Lax"}`,
  ];
  if (options.httpOnly) attrs.push("HttpOnly");
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}

// One vote per browser: a server-issued cookie identifies the voter. The value
// becomes the `viewer_id` used as the DB key, so anything that is not our own
// UUID shape is replaced, never trusted.
export function resolveViewerId(
  cookieHeader: string | undefined,
  env: string | undefined,
): {
  viewerId: string;
  setCookie: string | null;
} {
  const existing = parseCookies(cookieHeader)["viewer_id"];
  if (existing !== undefined && UUID_PATTERN.test(existing)) {
    return { viewerId: existing, setCookie: null };
  }
  const viewerId = randomUUID();
  return {
    viewerId,
    setCookie: formatSetCookie(viewerId, viewerCookieOptions(env)),
  };
}
