import { describe, expect, it } from "vitest";

import {
  ELECTRON_APP_CONTROL_PROTOCOL_VERSION,
  parseElectronAppControlMessage,
  parseElectronAppControlResponse,
} from "../src/electron-app-control-protocol.js";

describe("Electron app lifecycle control protocol", () => {
  it("keeps app registration and aggregate activity capability-minimal", () => {
    expect(parseElectronAppControlMessage({
      protocolVersion: ELECTRON_APP_CONTROL_PROTOCOL_VERSION,
      type: "register-app",
      appInstanceId: "app_instance_1234",
      processId: 123,
      startIdentity: "start_12345678",
      buildIdentity: "build_12345678",
    })).toMatchObject({ type: "register-app", processId: 123 });
    expect(parseElectronAppControlMessage({
      protocolVersion: ELECTRON_APP_CONTROL_PROTOCOL_VERSION,
      type: "activity",
      appInstanceId: "app_instance_1234",
      activeWindows: 2,
      bootstrappingWindows: 1,
    })).toMatchObject({ type: "activity", activeWindows: 2 });
    expect(parseElectronAppControlMessage({
      protocolVersion: ELECTRON_APP_CONTROL_PROTOCOL_VERSION,
      type: "detach-helper",
      appInstanceId: "app_instance_1234",
      helperId: "helper_instance_1234",
    })).toMatchObject({ type: "detach-helper", helperId: "helper_instance_1234" });
  });

  it("rejects review, resource, path, and credential authority on the lifecycle lane", () => {
    for (const extra of [
      { resourceId: "resource_12345678" },
      { sourcePath: "/private/Paper.pdf" },
      { credential: "secret" },
      { command: { type: "undo" } },
    ]) {
      expect(parseElectronAppControlMessage({
        protocolVersion: 1,
        type: "detach",
        appInstanceId: "app_instance_1234",
        reason: "controlled-exit",
        ...extra,
      })).toBeUndefined();
    }
    expect(parseElectronAppControlMessage({
      protocolVersion: 1,
      type: "detach-helper",
      appInstanceId: "app_instance_1234",
      helperId: "helper_instance_1234",
      sourcePath: "/private/Paper.pdf",
    })).toBeUndefined();
  });

  it("accepts only closed acknowledgement and replacement responses", () => {
    expect(parseElectronAppControlResponse({
      protocolVersion: 1,
      type: "ack",
      appInstanceId: "app_instance_1234",
    })).toMatchObject({ type: "ack" });
    expect(parseElectronAppControlResponse({
      protocolVersion: 1,
      type: "replacement-ready",
      appInstanceId: "app_instance_1234",
      activeWindows: 0,
    })).toMatchObject({ type: "replacement-ready" });
    expect(parseElectronAppControlResponse({
      protocolVersion: 1,
      type: "ack",
      appInstanceId: "app_instance_1234",
      token: "must-not-cross",
    })).toBeUndefined();
  });
});
