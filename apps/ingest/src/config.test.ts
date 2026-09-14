import { describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig: mqttEnabled (issue #25)", () => {
  test("OPENF1_LOGIN set, MQTT_ENABLED unset -> defaults true", () => {
    expect(loadConfig({ OPENF1_LOGIN: "l" }).mqttEnabled).toBe(true);
  });

  test("OPENF1_LOGIN unset, MQTT_ENABLED unset -> defaults false (the free tier has no MQTT)", () => {
    expect(loadConfig({}).mqttEnabled).toBe(false);
  });

  test("MQTT_ENABLED=false overrides an OPENF1_LOGIN default of true", () => {
    expect(loadConfig({ OPENF1_LOGIN: "l", MQTT_ENABLED: "false" }).mqttEnabled).toBe(false);
  });

  test("MQTT_ENABLED=true overrides a missing-login default of false", () => {
    expect(loadConfig({ MQTT_ENABLED: "true" }).mqttEnabled).toBe(true);
  });
});

describe("loadConfig: restTickMs (ADR-0030)", () => {
  test("no OpenF1 credentials -> free tier default 2200ms", () => {
    expect(loadConfig({}).restTickMs).toBe(2200);
  });

  test("OPENF1_LOGIN set but OPENF1_PASSWORD missing -> still free tier (not sponsored)", () => {
    expect(loadConfig({ OPENF1_LOGIN: "l" }).restTickMs).toBe(2200);
  });

  test("both OPENF1_LOGIN and OPENF1_PASSWORD set -> sponsored tier default 1100ms", () => {
    expect(loadConfig({ OPENF1_LOGIN: "l", OPENF1_PASSWORD: "p" }).restTickMs).toBe(1100);
  });

  test("REST_TICK_MS overrides the free-tier default", () => {
    expect(loadConfig({ REST_TICK_MS: "500" }).restTickMs).toBe(500);
  });

  test("REST_TICK_MS overrides the sponsored-tier default", () => {
    expect(loadConfig({ OPENF1_LOGIN: "l", OPENF1_PASSWORD: "p", REST_TICK_MS: "300" }).restTickMs).toBe(300);
  });

  test("an invalid REST_TICK_MS (non-numeric) falls back to the tier default and is reported", () => {
    const config = loadConfig({ REST_TICK_MS: "soon" });
    expect(config.restTickMs).toBe(2200);
    expect(config.restTickMsInvalid).toBe("soon");
  });

  test("an invalid REST_TICK_MS (zero) falls back to the tier default and is reported", () => {
    const config = loadConfig({ OPENF1_LOGIN: "l", OPENF1_PASSWORD: "p", REST_TICK_MS: "0" });
    expect(config.restTickMs).toBe(1100);
    expect(config.restTickMsInvalid).toBe("0");
  });

  test("a valid REST_TICK_MS reports no invalid value", () => {
    expect(loadConfig({ REST_TICK_MS: "1500" }).restTickMsInvalid).toBeUndefined();
  });

  test("REST_TICK_MS unset reports no invalid value", () => {
    expect(loadConfig({}).restTickMsInvalid).toBeUndefined();
  });
});

describe("loadConfig: liveLogDirExplicit", () => {
  test("LIVE_LOG_DIR unset -> false", () => {
    expect(loadConfig({}).liveLogDirExplicit).toBe(false);
  });

  test("LIVE_LOG_DIR set -> true", () => {
    expect(loadConfig({ LIVE_LOG_DIR: "/data/live-logs" }).liveLogDirExplicit).toBe(true);
  });

  test("LIVE_LOG_DIR set to the same value as the default -> still true", () => {
    expect(loadConfig({ LIVE_LOG_DIR: "./live-logs" }).liveLogDirExplicit).toBe(true);
  });
});
