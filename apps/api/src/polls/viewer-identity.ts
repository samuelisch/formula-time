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

// One vote per browser: a server-issued cookie identifies the voter. The value
// becomes the `viewer_id` used as the DB key, so anything that is not our own
// UUID shape is replaced, never trusted.
export function resolveViewerId(cookieHeader: string | undefined): {
  viewerId: string;
  setCookie: string | null;
} {
  const existing = parseCookies(cookieHeader)["viewer_id"];
  if (existing !== undefined && UUID_PATTERN.test(existing)) {
    return { viewerId: existing, setCookie: null };
  }
  const viewerId = randomUUID();
  return { viewerId, setCookie: `viewer_id=${viewerId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` };
}
