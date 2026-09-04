import { describe, expect, it } from "vitest";

import {
  MACOS_APP_CONTROL_PROTOCOL_VERSION,
  parseMacosAppControlMessage,
  parseMacosAppControlResponse,
} from "../src/macos-app-control-protocol.js";

describe("macOS app lifecycle control protocol", () => {
  it("keeps app registration and aggregate activity capability-minimal", () => {
    expect(parseMacosAppControlMessage({
      protocolVersion: MACOS_APP_CONTROL_PROTOCOL_VERSION,
      type: "register-app",
      appInstanceId: "app_instance_1234",
      processId: 123,
      startIdentity: "start_12345678",
      buildIdentity: "build_12345678",
    })).toMatchObject({ type: "register-app", processId: 123 });
    expect(parseMacosAppControlMessage({
      protocolVersion: MACOS_APP_CONTROL_PROTOCOL_VERSION,
      type: "activity",
      appInstanceId: "app_instance_1234",
      activeWindows: 2,
      bootstrappingWindows: 1,
    })).toMatchObject({ type: "activity", activeWindows: 2 });
  });

  it("rejects review, resource, path, and credential authority on the lifecycle lane", () => {
    for (const extra of [
      { resourceId: "resource_12345678" },
      { sourcePath: "/private/Paper.pdf" },
      { credential: "secret" },
      { command: { type: "undo" } },
    ]) {
      expect(parseMacosAppControlMessage({
        protocolVersion: 1,
        type: "detach",
        appInstanceId: "app_instance_1234",
        reason: "controlled-exit",
        ...extra,
      })).toBeUndefined();
    }
  });

  it("accepts only closed acknowledgement and replacement responses", () => {
    expect(parseMacosAppControlResponse({
      protocolVersion: 1,
      type: "ack",
      appInstanceId: "app_instance_1234",
    })).toMatchObject({ type: "ack" });
    expect(parseMacosAppControlResponse({
      protocolVersion: 1,
      type: "replacement-ready",
      appInstanceId: "app_instance_1234",
      activeWindows: 0,
    })).toMatchObject({ type: "replacement-ready" });
    expect(parseMacosAppControlResponse({
      protocolVersion: 1,
      type: "ack",
      appInstanceId: "app_instance_1234",
      token: "must-not-cross",
    })).toBeUndefined();
  });
});
