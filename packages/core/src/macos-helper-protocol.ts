import { parseNativeReviewHelperMessage, sanitizeNativeRuntimeProjection, validNativeReviewHelperResponse } from "./native-helper-protocol.js";
export {
  NATIVE_HELPER_PROTOCOL_VERSION as MACOS_HELPER_PROTOCOL_VERSION,
  NATIVE_HELPER_MAX_FRAME_BYTES as MACOS_HELPER_MAX_FRAME_BYTES,
  NATIVE_HELPER_MAX_STREAM_BYTES as MACOS_HELPER_MAX_STREAM_BYTES,
  NATIVE_HELPER_RESOURCE_CHUNK_BYTES as MACOS_HELPER_RESOURCE_CHUNK_BYTES,
  encodeNativeHelperFrame as encodeMacosHelperFrame,
  decodeNativeHelperFrame as decodeMacosHelperFrame,
} from "./native-helper-protocol.js";
export type { NativeRuntimeProjection as MacosRuntimeProjection, NativeReviewHelperMessage as MacosReviewHelperMessage, NativeReviewHelperResponse as MacosReviewHelperResponse } from "./native-helper-protocol.js";
export const parseMacosReviewHelperMessage = (value: unknown) => parseNativeReviewHelperMessage("macos", value);
export const sanitizeMacosRuntimeProjection = (value: unknown) => sanitizeNativeRuntimeProjection("macos", value);
export const validMacosReviewHelperResponse = (value: unknown) => validNativeReviewHelperResponse("macos", value);
