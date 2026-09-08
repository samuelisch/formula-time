import { describe, expect, it } from "vitest";
import { parseCookies, resolveViewerId } from "./viewer-identity.js";

describe("parseCookies", () => {
  it("parses a Cookie header into a map", () => {
    expect(parseCookies("a=1; viewer_id=abc-123; b=2")).toEqual({
      a: "1",
      viewer_id: "abc-123",
      b: "2",
    });
  });

  it("returns an empty map for an absent header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("resolveViewerId", () => {
  const validUuid = "00000000-0000-4000-8000-000000000001";

  it("trusts an existing cookie that matches the UUID shape", () => {
    const result = resolveViewerId(`viewer_id=${validUuid}`);
    expect(result).toEqual({ viewerId: validUuid, setCookie: null });
  });

  it("issues a fresh UUID and a Set-Cookie value when no cookie is present", () => {
    const result = resolveViewerId(undefined);
    expect(result.setCookie).toContain(`viewer_id=${result.viewerId}`);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Lax");
    expect(result.setCookie).toContain("Max-Age=31536000");
  });

  it("replaces a cookie value that is not our UUID shape, never trusting it", () => {
    const result = resolveViewerId("viewer_id=not-a-uuid");
    expect(result.viewerId).not.toBe("not-a-uuid");
    expect(result.setCookie).not.toBeNull();
  });
});
