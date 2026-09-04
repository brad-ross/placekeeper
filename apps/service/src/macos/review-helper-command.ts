import {
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
  try {
    for await (const raw of readMacosFrames(options.input)) {
      const message = parseMacosReviewHelperMessage(raw);
      if (message === undefined || message.windowId !== identity.windowId || message.attemptId !== identity.attemptId) {
        return 2;
      }
      const response = await exchange(identity.appInstanceId, identity.helperId, message);
      await options.write(encodeMacosHelperFrame(response));
      if (message.type === "release") return 0;
    }
    return 0;
  } catch {
    return 2;
  } finally {
    await detach(identity.appInstanceId, identity.helperId).catch(() => undefined);
  }
}

