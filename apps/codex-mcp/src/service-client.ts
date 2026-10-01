import { requestControl } from "../../service/src/host/launch-control.js";
import { defaultDaemonPaths } from "../../service/src/host/service-daemon.js";
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, parseCodexAppRequest, parseCodexAppResponse, parseCodexDisplayRequest, parseCodexDisplayReceipt, parseCodexPendingPresentation, type CodexAppRequest, type CodexAppResponse, type CodexDisplayRequest, type CodexDisplayReceipt, type CodexPendingPresentation } from "../../../packages/core/src/codex-mcp-protocol.js";

export interface NativeServiceClient {
  display(request: CodexDisplayRequest): Promise<{ receipt: CodexDisplayReceipt; pending: CodexPendingPresentation }>;
  app(request: CodexAppRequest): Promise<CodexAppResponse>;
}
/** A disposable socket per request; adapter EOF never owns daemon lifetime. */
export function createServiceClient(socketPath = defaultDaemonPaths().socketPath): NativeServiceClient {
  const control = (request: Parameters<typeof requestControl>[1]) => requestControl(socketPath, request, { maxMessageBytes: CODEX_MAX_ENCODED_RESPONSE_BYTES });
  return {
    async display(raw) {
      const request = parseCodexDisplayRequest(raw);
      if (request === undefined) throw new Error("invalid-display");
      const result = await control({ kind: "codex-display", request });
      if (result.kind !== "codex-display") throw new Error("native-unavailable");
      const receipt = parseCodexDisplayReceipt(result.receipt), pending = parseCodexPendingPresentation(result.pending);
      if (receipt === undefined || pending === undefined || receipt.receiptId !== pending.receiptId || receipt.attemptId !== pending.attemptId || receipt.generation !== pending.generation) throw new Error("invalid-service-response");
      return { receipt, pending };
    },
    async app(raw) {
      const request = parseCodexAppRequest(raw);
      if (request === undefined) return { status: "denied", reason: "invalid" };
      const result = await control({ kind: "codex-app", request });
      const response = result.kind === "codex-app" ? parseCodexAppResponse(result.response) : undefined;
      if (response === undefined) throw new Error("native-unavailable");
      return response;
    },
  };
}
