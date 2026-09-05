import {
  parseMacosAppControlMessage,
  type MacosAppControlMessage,
  type MacosAppControlResponse,
} from "../../../../packages/core/src/macos-app-control-protocol.js";
import { encodeMacosHelperFrame } from "../../../../packages/core/src/macos-helper-protocol.js";
import { macosAppControlThroughDaemon } from "../host/service-daemon.js";
import { readMacosFrames } from "./framed-input.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface MacosLifecycleControlCommandOptions {
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (frame: Buffer) => Promise<void>;
  readonly appInstanceId: string;
  readonly exchange?: (message: MacosAppControlMessage) => Promise<MacosAppControlResponse>;
}

export async function runMacosLifecycleControlCommand(
  options: MacosLifecycleControlCommandOptions,
): Promise<number> {
  if (!ID.test(options.appInstanceId)) return 2;
  const exchange = options.exchange ?? macosAppControlThroughDaemon;
  let registered = false;
  let detached = false;
  try {
    for await (const raw of readMacosFrames(options.input)) {
      const message = parseMacosAppControlMessage(raw);
      if (message === undefined || message.appInstanceId !== options.appInstanceId
        || (!registered && message.type !== "register-app")
        || (registered && message.type === "register-app")) return 2;
      const response = await exchange(message);
      await options.write(encodeMacosHelperFrame(response));
      if (response.type === "failure") return 2;
      registered = true;
      if (message.type === "detach") {
        detached = true;
        return 0;
      }
    }
    return 0;
  } catch {
    return 2;
  } finally {
    if (registered && !detached) {
      await exchange({
        protocolVersion: 1,
        type: "detach",
        appInstanceId: options.appInstanceId,
        reason: "eof",
      }).catch(() => undefined);
    }
  }
}

