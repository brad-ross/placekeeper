import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  PreparedProductionHandoff,
  ProductionSession,
  ProductionSessionApi,
  ProductionScope,
} from "./ProductionReviewApp.js";
import type { RejectedReviewCommand } from "./ReviewShell.js";

function client(session: ProductionSession) {
  const base = `/s/${session.sessionId}`;
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${session.credential}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`The local review action failed safely (${response.status}).`);
    return response.json() as Promise<T>;
  };
  const post = <T>(path: string, body: unknown = {}) => request<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { request, post };
}

export async function loadProductionSession(session: ProductionSession): Promise<{
  readonly state: ReviewState;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
}> {
  const { request, post } = client(session);
  const [state, scope] = await Promise.all([
    request<ReviewState>("/state"),
    request<ProductionScope>("/scope"),
  ]);
  return {
    state,
    scope,
    api: {
      command: async (command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> => {
        const response = await fetch(`/s/${session.sessionId}/commands`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
        });
        if (response.status === 409) {
          return {
            accepted: false,
            state: await request<ReviewState>("/state"),
            message: "Another review window changed this draft. The latest saved revision is shown; retry your command.",
          };
        }
        if (!response.ok) throw new Error(`The local review action failed safely (${response.status}).`);
        return response.json() as Promise<ReviewState>;
      },
      saveReviewedCopy: () => post("/delivery/human/save"),
      replaceOriginal: () => post("/delivery/human/replace"),
      prepareCodex: () => post<PreparedProductionHandoff>("/delivery/codex/prepare"),
      saveInstruction: (receiptId) => post("/delivery/codex/instruction", { receiptId }),
      checkCodex: (input) => post("/delivery/codex/result", input),
      finish: async () => { await post("/finish"); },
      discard: async () => { await post("/discard"); },
    },
  };
}
