import { describe, expect, it, vi } from "vitest";

import {
  decodeMacosHelperFrame,
  encodeMacosHelperFrame,
  type MacosReviewHelperResponse,
} from "../../../packages/core/src/macos-helper-protocol.js";
import { runMacosLifecycleControlCommand } from "../src/macos/lifecycle-control-command.js";
import {
  macosReviewHelperIdentity,
  runMacosReviewHelperCommand,
} from "../src/macos/review-helper-command.js";

async function* splitFrames(values: readonly unknown[]): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.concat(values.map(encodeMacosHelperFrame));
  yield bytes.subarray(0, 3);
  yield bytes.subarray(3, 11);
  yield bytes.subarray(11);
}

describe("macOS process helpers", () => {
  it("forwards only its window's framed review messages and detaches on exit", async () => {
    const identity = {
      appInstanceId: "app_instance_1234",
      helperId: "helper_instance_1234",
      windowId: "window_instance_1234",
      attemptId: "attempt_instance_1234",
    };
    const base = {
      protocolVersion: 1 as const,
      windowId: identity.windowId,
      attemptId: identity.attemptId,
    };
    const exchange = vi.fn(async (_app: string, _helper: string, message: { requestId: string; type: string }) => ({
      ...base,
      requestId: message.requestId,
      type: message.type === "release" ? "released" : "failure",
      ...(message.type === "release" ? {} : { code: "unavailable" as const }),
    } as MacosReviewHelperResponse));
    const detach = vi.fn(async () => undefined);
    const output: Buffer[] = [];
    await expect(runMacosReviewHelperCommand({
      input: splitFrames([
        { ...base, requestId: "request_admit_1234", type: "admit", sourcePath: "/private/tmp/Paper.pdf" },
        { ...base, requestId: "request_release_1234", type: "release" },
      ]),
      write: async (frame) => { output.push(frame); },
      identity,
      exchange,
      detach,
    })).resolves.toBe(0);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(output.map(decodeMacosHelperFrame)).toMatchObject([
      { type: "failure", code: "unavailable" },
      { type: "released" },
    ]);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("rejects cross-window input before forwarding it", async () => {
    const exchange = vi.fn();
    const detach = vi.fn(async () => undefined);
    await expect(runMacosReviewHelperCommand({
      input: splitFrames([{
        protocolVersion: 1,
        type: "release",
        windowId: "window_wrong_1234",
        attemptId: "attempt_instance_1234",
        requestId: "request_release_5678",
      }]),
      write: async () => undefined,
      identity: {
        appInstanceId: "app_instance_1234",
        helperId: "helper_instance_1234",
        windowId: "window_instance_1234",
        attemptId: "attempt_instance_1234",
      },
      exchange,
      detach,
    })).resolves.toBe(2);
    expect(exchange).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("turns lifecycle pipe EOF into app-instance detachment", async () => {
    const appInstanceId = "app_instance_5678";
    const exchanged: unknown[] = [];
    const output: Buffer[] = [];
    await expect(runMacosLifecycleControlCommand({
      input: splitFrames([
        {
          protocolVersion: 1,
          type: "register-app",
          appInstanceId,
          processId: 123,
          startIdentity: "start_identity_5678",
          buildIdentity: "build_identity_5678",
        },
        {
          protocolVersion: 1,
          type: "activity",
          appInstanceId,
          activeWindows: 1,
          bootstrappingWindows: 1,
        },
      ]),
      write: async (frame) => { output.push(frame); },
      appInstanceId,
      exchange: async (message) => {
        exchanged.push(message);
        return { protocolVersion: 1, type: "ack", appInstanceId };
      },
    })).resolves.toBe(0);
    expect(output.map(decodeMacosHelperFrame)).toHaveLength(2);
    expect(exchanged).toMatchObject([
      { type: "register-app" },
      { type: "activity" },
      { type: "detach", reason: "eof" },
    ]);
  });

  it("requires every process identity before starting", () => {
    expect(macosReviewHelperIdentity({
      PLACEKEEPER_APP_INSTANCE_ID: "app_instance_1234",
      PLACEKEEPER_HELPER_ID: "helper_instance_1234",
      PLACEKEEPER_WINDOW_ID: "window_instance_1234",
    })).toBeUndefined();
  });
});

