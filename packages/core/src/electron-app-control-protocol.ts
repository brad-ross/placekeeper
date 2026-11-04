export {
  NATIVE_APP_CONTROL_PROTOCOL_VERSION as ELECTRON_APP_CONTROL_PROTOCOL_VERSION,
  parseNativeAppControlMessage as parseElectronAppControlMessage,
  parseNativeAppControlResponse as parseElectronAppControlResponse,
} from "./native-app-control-protocol.js";
export type { NativeAppControlMessage as ElectronAppControlMessage, NativeAppControlResponse as ElectronAppControlResponse } from "./native-app-control-protocol.js";
