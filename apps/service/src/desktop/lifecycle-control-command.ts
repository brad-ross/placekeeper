import {
  parseNativeAppControlMessage,
  type NativeAppControlMessage,
  type NativeAppControlResponse,
} from "../../../../packages/core/src/native-app-control-protocol.js";
import { encodeNativeHelperFrame } from "../../../../packages/core/src/native-helper-protocol.js";
import { readNativeFrames } from "./framed-input.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface NativeLifecycleControlCommandOptions {
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (frame: Buffer) => Promise<void>;
  readonly appInstanceId: string;
  readonly exchange: (message: NativeAppControlMessage) => Promise<NativeAppControlResponse>;
}

export async function runNativeLifecycleControlCommand(
  options: NativeLifecycleControlCommandOptions,
): Promise<number> {
  if (!ID.test(options.appInstanceId)) return 2;
  const exchange = options.exchange;
  let registered = false;
  let detached = false;
  try {
    for await (const raw of readNativeFrames(options.input)) {
      const message = parseNativeAppControlMessage(raw);
      if (message === undefined || message.appInstanceId !== options.appInstanceId
        || (!registered && message.type !== "register-app")
        || (registered && message.type === "register-app")) return 2;
      const response = await exchange(message);
      if (response.type !== "failure") registered = true;
      await options.write(encodeNativeHelperFrame(response));
      if (response.type === "failure") return 2;
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

