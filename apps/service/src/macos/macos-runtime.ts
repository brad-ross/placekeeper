import { NativeRuntimeManager, type NativeRuntimeBackend, type NativeRuntimeManagerOptions } from "../desktop/native-runtime.js";
export type { NativeRuntimeBackend as MacosRuntimeBackend, NativeRuntimeTrustedProjection as MacosRuntimeTrustedProjection, NativeRuntimeProjection as MacosRuntimeProjection, NativeRuntimeManagerOptions as MacosRuntimeManagerOptions } from "../desktop/native-runtime.js";
export class MacosRuntimeManager extends NativeRuntimeManager {
  constructor(backend: NativeRuntimeBackend, options: NativeRuntimeManagerOptions = {}) { super("macos", backend, options); }
}
