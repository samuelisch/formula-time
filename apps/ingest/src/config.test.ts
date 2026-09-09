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
