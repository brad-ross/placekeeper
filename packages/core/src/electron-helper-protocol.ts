import { parseNativeReviewHelperMessage, sanitizeNativeRuntimeProjection, validNativeReviewHelperResponse } from "./native-helper-protocol.js";
export {
  NATIVE_HELPER_PROTOCOL_VERSION as ELECTRON_HELPER_PROTOCOL_VERSION,
  NATIVE_HELPER_MAX_FRAME_BYTES as ELECTRON_HELPER_MAX_FRAME_BYTES,
  NATIVE_HELPER_MAX_STREAM_BYTES as ELECTRON_HELPER_MAX_STREAM_BYTES,
  NATIVE_HELPER_RESOURCE_CHUNK_BYTES as ELECTRON_HELPER_RESOURCE_CHUNK_BYTES,
  encodeNativeHelperFrame as encodeElectronHelperFrame,
  decodeNativeHelperFrame as decodeElectronHelperFrame,
} from "./native-helper-protocol.js";
export type { NativeRuntimeProjection as ElectronRuntimeProjection, NativeReviewHelperMessage as ElectronReviewHelperMessage, NativeReviewHelperResponse as ElectronReviewHelperResponse } from "./native-helper-protocol.js";
export const parseElectronReviewHelperMessage = (value: unknown) => parseNativeReviewHelperMessage("electron", value);
export const sanitizeElectronRuntimeProjection = (value: unknown) => sanitizeNativeRuntimeProjection("electron", value);
export const validElectronReviewHelperResponse = (value: unknown) => validNativeReviewHelperResponse("electron", value);
