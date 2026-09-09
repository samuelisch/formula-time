import { describe, expect, it } from "vitest";
import { parseCookies, resolveViewerId, viewerCookieOptions } from "./viewer-identity.js";

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

describe("viewerCookieOptions", () => {
  it("is SameSite=None, Secure in production (split-origin split cookie)", () => {
    expect(viewerCookieOptions("production")).toEqual({
      path: "/",
      maxAge: 31536000,
      sameSite: "none",
      httpOnly: true,
      secure: true,
    });
  });

  it("is SameSite=Lax, not Secure outside production (dev over plain http)", () => {
    expect(viewerCookieOptions("development")).toEqual({
      path: "/",
      maxAge: 31536000,
      sameSite: "lax",
      httpOnly: true,
      secure: false,
    });
    expect(viewerCookieOptions(undefined)).toEqual({
      path: "/",
      maxAge: 31536000,
      sameSite: "lax",
      httpOnly: true,
      secure: false,
    });
  });
});

describe("resolveViewerId", () => {
  const validUuid = "00000000-0000-4000-8000-000000000001";

  it("trusts an existing cookie that matches the UUID shape", () => {
    const result = resolveViewerId(`viewer_id=${validUuid}`, "production");
    expect(result).toEqual({ viewerId: validUuid, setCookie: null });
  });

  it("issues a fresh UUID and a Lax, non-Secure Set-Cookie value outside production", () => {
    const result = resolveViewerId(undefined, "development");
    expect(result.setCookie).toContain(`viewer_id=${result.viewerId}`);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Lax");
    expect(result.setCookie).toContain("Max-Age=31536000");
    expect(result.setCookie).not.toContain("Secure");
  });

  it("issues a SameSite=None, Secure Set-Cookie value in production, from the same helper", () => {
    const result = resolveViewerId(undefined, "production");
    expect(result.setCookie).toContain(`viewer_id=${result.viewerId}`);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=None");
    expect(result.setCookie).toContain("Max-Age=31536000");
    expect(result.setCookie).toContain("Secure");
  });

  it("replaces a cookie value that is not our UUID shape, never trusting it", () => {
    const result = resolveViewerId("viewer_id=not-a-uuid", "production");
    expect(result.viewerId).not.toBe("not-a-uuid");
    expect(result.setCookie).not.toBeNull();
  });
});
