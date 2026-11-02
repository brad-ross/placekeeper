import { runNativeLifecycleControlCommand, type NativeLifecycleControlCommandOptions } from "../desktop/lifecycle-control-command.js";
import { macosAppControlThroughDaemon } from "../host/service-daemon.js";
export type MacosLifecycleControlCommandOptions = Omit<NativeLifecycleControlCommandOptions, "exchange"> & Partial<Pick<NativeLifecycleControlCommandOptions, "exchange">>;
export function runMacosLifecycleControlCommand(options: MacosLifecycleControlCommandOptions): Promise<number> {
  return runNativeLifecycleControlCommand({ ...options, exchange: options.exchange ?? macosAppControlThroughDaemon });
}
