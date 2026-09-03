export const REVIEW_RUNTIME_PROTOCOL = "placekeeper.review-runtime" as const;
export const REVIEW_RUNTIME_VERSION = 1 as const;

export const REVIEW_RUNTIME_METHODS = [
  "bootstrap",
  "presence",
  "detach",
  "command",
  "saveStatus",
  "saveProposal",
  "chooseCopy",
  "chooseFolder",
  "chooseOriginal",
  "retrySave",
  "locateSave",
  "scope",
  "forwardSyncTex",
  "reverseSyncTex",
  "exportReviewedCopy",
] as const;

export type ReviewRuntimeMethod = typeof REVIEW_RUNTIME_METHODS[number];
export type ReviewRuntimeInvokeMethod = Exclude<ReviewRuntimeMethod, "bootstrap">;
export type ReviewRuntimeBrokerMethod = Exclude<
  ReviewRuntimeInvokeMethod,
  "presence" | "detach"
>;

const REVIEW_RUNTIME_METHOD_SET: ReadonlySet<string> = new Set(REVIEW_RUNTIME_METHODS);
const REVIEW_PANEL_KEY = /^[A-Za-z0-9_-]{8,128}$/u;

export function isReviewRuntimeMethod(value: unknown): value is ReviewRuntimeMethod {
  return typeof value === "string" && REVIEW_RUNTIME_METHOD_SET.has(value);
}

export function isReviewPanelKey(value: unknown): value is string {
  return typeof value === "string" && REVIEW_PANEL_KEY.test(value);
}
