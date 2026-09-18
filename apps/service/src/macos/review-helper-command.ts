import { createHash, randomUUID } from "node:crypto";

import {
  MACOS_HELPER_MAX_FRAME_BYTES,
  MACOS_HELPER_MAX_STREAM_BYTES,
  MACOS_HELPER_RESOURCE_CHUNK_BYTES,
  encodeMacosHelperFrame,
  parseMacosReviewHelperMessage,
  type MacosReviewHelperMessage,
  type MacosReviewHelperResponse,
} from "../../../../packages/core/src/macos-helper-protocol.js";
import {
  detachMacosRuntimeThroughDaemon,
  macosRuntimeThroughDaemon,
} from "../host/service-daemon.js";
import { readMacosFrames } from "./framed-input.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface MacosReviewHelperIdentity {
  readonly appInstanceId: string;
  readonly helperId: string;
  readonly windowId: string;
  readonly attemptId: string;
}

export interface MacosReviewHelperCommandOptions {
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (frame: Buffer) => Promise<void>;
  readonly identity: MacosReviewHelperIdentity;
  readonly exchange?: (
    appInstanceId: string,
    helperId: string,
    message: MacosReviewHelperMessage,
  ) => Promise<MacosReviewHelperResponse>;
  readonly detach?: (appInstanceId: string, helperId: string) => Promise<void>;
  /** Receives fixed protocol-stage identifiers only; never request values or
   * error messages that could contain a document path. */
  readonly diagnostic?: (stage: string) => void;
}

function diagnosticFailureKind(error: unknown): string {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  if (code === "EPIPE") return "broken-pipe";
  if (code === "ECONNRESET") return "connection-reset";
  if (error instanceof RangeError) return "range-error";
  if (error instanceof TypeError) return "type-error";
  return "error";
}

function encodeBodyFrame(body: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

function* encodeResponseFrames(
  message: MacosReviewHelperMessage,
  response: MacosReviewHelperResponse,
  diagnostic?: (stage: string) => void,
): Generator<Buffer> {
  const body = Buffer.from(JSON.stringify(response), "utf8");
  if (body.byteLength <= MACOS_HELPER_MAX_FRAME_BYTES) {
    yield encodeBodyFrame(body);
    return;
  }
  if (body.byteLength <= MACOS_HELPER_MAX_STREAM_BYTES) {
    const streamId = `stream_${randomUUID().replaceAll("-", "")}`;
    const chunkCount = Math.ceil(body.byteLength / MACOS_HELPER_RESOURCE_CHUNK_BYTES);
    const envelope = {
      protocolVersion: 1 as const,
      windowId: message.windowId,
      attemptId: message.attemptId,
      requestId: message.requestId,
    };
    yield encodeMacosHelperFrame({
      ...envelope,
      type: "response-stream-start",
      streamId,
      totalBytes: body.byteLength,
      chunkCount,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    for (let sequence = 0; sequence < chunkCount; sequence += 1) {
      const offset = sequence * MACOS_HELPER_RESOURCE_CHUNK_BYTES;
      yield encodeMacosHelperFrame({
        ...envelope,
        type: "response-stream-chunk",
        streamId,
        sequence,
        data: body.subarray(offset, offset + MACOS_HELPER_RESOURCE_CHUNK_BYTES).toString("base64"),
      });
    }
    return;
  }
  diagnostic?.(`write-${message.type}-stream-too-large`);
  yield encodeMacosHelperFrame({
    protocolVersion: 1,
    windowId: message.windowId,
    attemptId: message.attemptId,
    requestId: message.requestId,
    type: "failure",
    code: "budget",
  } satisfies MacosReviewHelperResponse);
}

export function macosReviewHelperIdentity(
  environment: NodeJS.ProcessEnv,
): MacosReviewHelperIdentity | undefined {
  const identity = {
    appInstanceId: environment.PLACEKEEPER_APP_INSTANCE_ID,
    helperId: environment.PLACEKEEPER_HELPER_ID,
    windowId: environment.PLACEKEEPER_WINDOW_ID,
    attemptId: environment.PLACEKEEPER_ATTEMPT_ID,
  };
  return Object.values(identity).every((value) => typeof value === "string" && ID.test(value))
    ? identity as MacosReviewHelperIdentity
    : undefined;
}

export async function runMacosReviewHelperCommand(
  options: MacosReviewHelperCommandOptions,
): Promise<number> {
  const { identity } = options;
  if (!Object.values(identity).every((value) => ID.test(value))) return 2;
  const exchange = options.exchange ?? macosRuntimeThroughDaemon;
  const detach = options.detach ?? detachMacosRuntimeThroughDaemon;
  let failureStage = "input";
  try {
    for await (const raw of readMacosFrames(options.input)) {
      failureStage = "parse";
      const message = parseMacosReviewHelperMessage(raw);
      if (message === undefined || message.windowId !== identity.windowId || message.attemptId !== identity.attemptId) {
        options.diagnostic?.("invalid-frame");
        return 2;
      }
      failureStage = `exchange-${message.type}`;
      const response = await exchange(identity.appInstanceId, identity.helperId, message);
      failureStage = `write-${message.type}`;
      for (const frame of encodeResponseFrames(message, response, options.diagnostic)) {
        await options.write(frame);
      }
      if (message.type === "release") return 0;
      failureStage = "input";
    }
    options.diagnostic?.("input-eof");
    return 2;
  } catch (error) {
    options.diagnostic?.(`${failureStage}-${diagnosticFailureKind(error)}`);
    return 2;
  } finally {
    await detach(identity.appInstanceId, identity.helperId).catch(() => undefined);
  }
}
