import { describe, expect, it, vi } from "vitest";

import {
  MACOS_HELPER_MAX_STREAM_BYTES,
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
    const diagnostic = vi.fn();
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
      diagnostic,
    })).resolves.toBe(2);
    expect(exchange).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("invalid-frame");
  });

  it("treats input EOF before release as helper failure", async () => {
    const detach = vi.fn(async () => undefined);
    const diagnostic = vi.fn();
    await expect(runMacosReviewHelperCommand({
      input: splitFrames([]),
      write: async () => undefined,
      identity: {
        appInstanceId: "app_instance_1234",
        helperId: "helper_instance_1234",
        windowId: "window_instance_1234",
        attemptId: "attempt_instance_1234",
      },
      exchange: vi.fn(),
      detach,
      diagnostic,
    })).resolves.toBe(2);
    expect(diagnostic).toHaveBeenCalledWith("input-eof");
    expect(detach).toHaveBeenCalledOnce();
  });

  it("reports only the fixed failing protocol stage when an exchange throws", async () => {
    const diagnostic = vi.fn();
    await expect(runMacosReviewHelperCommand({
      input: splitFrames([{
        protocolVersion: 1,
        type: "keepalive",
        windowId: "window_instance_1234",
        attemptId: "attempt_instance_1234",
        requestId: "request_keepalive_5678",
      }]),
      write: async () => undefined,
      identity: {
        appInstanceId: "app_instance_1234",
        helperId: "helper_instance_1234",
        windowId: "window_instance_1234",
        attemptId: "attempt_instance_1234",
      },
      exchange: async () => { throw new Error("/private/secret/Paper.pdf"); },
      detach: async () => undefined,
      diagnostic,
    })).resolves.toBe(2);
    expect(diagnostic).toHaveBeenCalledWith("exchange-keepalive-error");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Paper.pdf");
  });

  it("streams a valid multibyte response above one frame and remains alive", async () => {
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
    const exchange = vi.fn(async (_app: string, _helper: string, message: { requestId: string; type: string }) => {
      if (message.type === "release") return { ...base, requestId: message.requestId, type: "released" as const };
      return {
        ...base,
        requestId: message.requestId,
        type: "refreshed" as const,
        projection: {
          sessionId: "00000000-0000-4000-8000-000000000001",
          generation: 1,
          revision: 1,
          state: { oversized: "é".repeat(2_200_000) },
          scope: {},
          saveStatus: {},
          protected: false,
          document: { sha256: "a".repeat(64), byteLength: 5, generation: 1 },
        },
      };
    });
    const diagnostic = vi.fn();
    const output: Buffer[] = [];

    await expect(runMacosReviewHelperCommand({
      input: splitFrames([
        { ...base, requestId: "request_refresh_1234", type: "refresh" },
        { ...base, requestId: "request_release_1234", type: "release" },
      ]),
      write: async (frame) => { output.push(frame); },
      identity,
      exchange: exchange as never,
      detach: async () => undefined,
      diagnostic,
    })).resolves.toBe(0);

    expect(exchange).toHaveBeenCalledTimes(2);
    const decoded = output.map(decodeMacosHelperFrame) as Array<Record<string, unknown>>;
    expect(decoded[0]).toMatchObject({ type: "response-stream-start", requestId: "request_refresh_1234" });
    const chunks = decoded.slice(1, -1);
    expect(chunks.every((frame, sequence) => frame.type === "response-stream-chunk" && frame.sequence === sequence))
      .toBe(true);
    const reconstructed = Buffer.concat(chunks.map((frame) => Buffer.from(String(frame.data), "base64")));
    expect(JSON.parse(reconstructed.toString("utf8"))).toMatchObject({
      type: "refreshed",
      projection: { state: { oversized: expect.stringContaining("ééé") } },
    });
    expect(decoded.at(-1)).toMatchObject({ type: "released", requestId: "request_release_1234" });
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("returns a recoverable budget failure beyond the bounded response stream", async () => {
    const identity = {
      appInstanceId: "app_instance_1234", helperId: "helper_instance_1234",
      windowId: "window_instance_1234", attemptId: "attempt_instance_1234",
    };
    const base = { protocolVersion: 1 as const, windowId: identity.windowId, attemptId: identity.attemptId };
    const output: Buffer[] = [];
    const diagnostic = vi.fn();
    await expect(runMacosReviewHelperCommand({
      input: splitFrames([{ ...base, requestId: "request_refresh_1234", type: "refresh" }]),
      write: async (frame) => { output.push(frame); },
      identity,
      exchange: async () => ({
        ...base, requestId: "request_refresh_1234", type: "result", method: "command",
        payload: "x".repeat(MACOS_HELPER_MAX_STREAM_BYTES),
      }),
      detach: async () => undefined,
      diagnostic,
    })).resolves.toBe(2);
    expect(decodeMacosHelperFrame(output[0]!)).toMatchObject({ type: "failure", code: "budget" });
    expect(diagnostic).toHaveBeenCalledWith("write-refresh-stream-too-large");
    expect(diagnostic).toHaveBeenCalledWith("input-eof");
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
