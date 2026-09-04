import { MACOS_HELPER_MAX_FRAME_BYTES } from "../../../../packages/core/src/macos-helper-protocol.js";

/** Decodes a stream of length-prefixed JSON frames without allowing a partial
 * or malicious frame to grow the process buffer beyond the protocol limit. */
export async function* readMacosFrames(
  input: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length === 0 || length > MACOS_HELPER_MAX_FRAME_BYTES) {
        throw new Error("macOS helper frame length is invalid");
      }
      if (buffered.byteLength < length + 4) break;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      yield JSON.parse(body.toString("utf8")) as unknown;
    }
    if (buffered.byteLength > MACOS_HELPER_MAX_FRAME_BYTES + 4) {
      throw new Error("macOS helper frame is too large");
    }
  }
  if (buffered.byteLength !== 0) throw new Error("macOS helper frame ended early");
}

