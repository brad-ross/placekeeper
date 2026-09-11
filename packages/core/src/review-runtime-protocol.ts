import type { SaveDestinationConfirmation } from "./review-model.js";
export const REVIEW_RUNTIME_PROTOCOL = "placekeeper.review-runtime" as const;
export const REVIEW_RUNTIME_VERSION = 2 as const;

export const REVIEW_RUNTIME_HOSTS = ["vscode", "chrome", "macos"] as const;
export type ReviewRuntimeHost = typeof REVIEW_RUNTIME_HOSTS[number];

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

export const REVIEW_RUNTIME_HOST_METHODS = {
  vscode: REVIEW_RUNTIME_METHODS,
  chrome: REVIEW_RUNTIME_METHODS.filter((method) => (
    method !== "forwardSyncTex" && method !== "reverseSyncTex"
  )),
  macos: REVIEW_RUNTIME_METHODS.filter((method) => (
    method !== "forwardSyncTex" && method !== "reverseSyncTex"
  )),
} as const satisfies Readonly<Record<ReviewRuntimeHost, readonly ReviewRuntimeMethod[]>>;

const REVIEW_RUNTIME_METHOD_SET: ReadonlySet<string> = new Set(REVIEW_RUNTIME_METHODS);
const REVIEW_PANEL_KEY = /^[A-Za-z0-9_-]{8,128}$/u;

export function isReviewRuntimeMethod(value: unknown): value is ReviewRuntimeMethod {
  return typeof value === "string" && REVIEW_RUNTIME_METHOD_SET.has(value);
}

export function isReviewRuntimeMethodForHost(
  host: ReviewRuntimeHost,
  value: unknown,
): value is ReviewRuntimeMethod {
  return isReviewRuntimeMethod(value) &&
    (REVIEW_RUNTIME_HOST_METHODS[host] as readonly ReviewRuntimeMethod[]).includes(value);
}

export function isReviewPanelKey(value: unknown): value is string {
  return typeof value === "string" && REVIEW_PANEL_KEY.test(value);
}

const SAFE_RUNTIME_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FORBIDDEN_CHROME_KEY = /(?:authorization|bindProof|capability|commandId|credential|executable|headers|originalUrl|presentationId|sourceRoot|sourceUrl|syncTex|taskId)/iu;
const BIDI_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SAVE_FAILURE_REASONS = new Set([
  "destination-unconfigured",
  "missing",
  "invalid-annotation-geometry",
  "target-changed",
  "permission-denied",
  "verification-failed",
  "write-failed",
]);
const COMMITTED_REVIEWED_COPY_WARNING =
  "The reviewed copy was created, but final durability bookkeeping was interrupted. Verify the saved artifact before closing the review.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function sanitizeReviewRuntimeDisplayString(value: unknown, limit = 255): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(BIDI_OR_CONTROL, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return [...normalized].slice(0, limit).join("");
}

function closedJsonClone(
  value: unknown,
  budget: { nodes: number } = { nodes: 0 },
  depth = 0,
): unknown | undefined {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 32) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const cloned = closedJsonClone(item, budget, depth + 1);
      if (cloned === undefined) return undefined;
      result.push(cloned);
    }
    return result;
  }
  if (!record(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_CHROME_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    const cloned = closedJsonClone(item, budget, depth + 1);
    if (cloned === undefined) return undefined;
    result[key] = cloned;
  }
  return result;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeChromeCommand(value: unknown): unknown | undefined {
  if (!record(value) || typeof value.type !== "string" || !safeInteger(value.expectedRevision)) return undefined;
  const keys: Readonly<Record<string, readonly string[]>> = {
    "set-annotation-name": ["type", "expectedRevision", "annotationName"],
    add: ["type", "expectedRevision", "item", "authoring"],
    edit: ["type", "expectedRevision", "id", "updatedAt", "payload"],
    remove: ["type", "expectedRevision", "id"],
    undo: ["type", "expectedRevision"],
    redo: ["type", "expectedRevision"],
    "put-draft": ["type", "expectedRevision", "expectedDraftRevision", "draft"],
    reattach: ["type", "expectedRevision", "id", "expectedReconciliationRevision", "ownerViewId", "anchor", "updatedAt"],
    "apply-draft": ["type", "expectedRevision", "id", "expectedDraftRevision", "ownerViewId", "updatedAt"],
    "discard-reconciliation": ["type", "expectedRevision", "target", "id", "expectedTargetRevision", "ownerViewId", "reason", "discardedAt"],
  };
  if (value.type === "set-annotation-name" && typeof value.annotationName !== "string") return undefined;
  const allowed = keys[value.type];
  if (allowed === undefined || !hasOnlyKeys(value, allowed)) return undefined;
  return closedJsonClone(value);
}

function safeChromeCanonicalLinkBase(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("placekeeper:///") || /[?#]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "placekeeper:" || url.username !== "" || url.password !== "" || url.host !== "") {
      return undefined;
    }
    if (decodeURIComponent(url.pathname).includes("://")) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function safeChromeLocation(value: unknown): unknown | undefined {
  if (!record(value) || !Number.isSafeInteger(value.page) || (value.page as number) < 1) return undefined;
  if (value.kind === "page" && hasOnlyKeys(value, ["kind", "page"])) return { kind: "page", page: value.page };
  if (value.kind === "item" && hasOnlyKeys(value, ["kind", "page", "itemId"]) &&
    typeof value.itemId === "string" && SESSION_ID.test(value.itemId)) {
    return { kind: "item", page: value.page, itemId: value.itemId };
  }
  if (value.kind === "destination" && hasOnlyKeys(value, ["kind", "page", "mode", "params"]) &&
    typeof value.mode === "string" && value.mode.length <= 64 && Array.isArray(value.params) &&
    value.params.length <= 8 && value.params.every((part) => typeof part === "number" && Number.isFinite(part))) {
    return { kind: "destination", page: value.page, mode: value.mode, params: [...value.params] };
  }
  return undefined;
}

function safeChromeState(value: unknown): unknown | undefined {
  if (!record(value) || !hasOnlyKeys(value, [
    "schemaVersion", "sessionId", "source", "sourceRootId", "revision", "lifecycle", "items",
    "workflow", "pendingDrafts", "discardAudit", "history", "historyCursor", "nativeAnnotationImportDigest", "annotationName",
  ])) return undefined;
  const { sourceRootId: _sourceRootId, ...candidate } = value;
  if ((candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) ||
    (candidate.annotationName !== undefined && typeof candidate.annotationName !== "string") ||
    !SESSION_ID.test(String(candidate.sessionId)) || !safeInteger(candidate.revision) ||
    (candidate.nativeAnnotationImportDigest !== undefined &&
      (typeof candidate.nativeAnnotationImportDigest !== "string" ||
        !SHA256.test(candidate.nativeAnnotationImportDigest))) ||
    !safeInteger(candidate.historyCursor) || !record(candidate.source) || !record(candidate.workflow) ||
    !Array.isArray(candidate.items) || !Array.isArray(candidate.pendingDrafts) ||
    !Array.isArray(candidate.discardAudit) || !Array.isArray(candidate.history)) return undefined;
  if (!hasOnlyKeys(candidate.source, ["fileId", "digest", "byteLength"]) ||
    !SESSION_ID.test(String(candidate.source.fileId)) || !SHA256.test(String(candidate.source.digest)) ||
    !safeInteger(candidate.source.byteLength) || candidate.source.byteLength === 0) return undefined;
  if (!hasOnlyKeys(candidate.workflow, [
    "schemaVersion", "mode", "documentRole", "documentGeneration", "freshness", "historyBoundary",
  ]) || candidate.workflow.schemaVersion !== 1 ||
    (candidate.workflow.mode !== "standard" && candidate.workflow.mode !== "generated-output") ||
    (candidate.workflow.documentRole !== "source-pdf" && candidate.workflow.documentRole !== "generated-output") ||
    !safeInteger(candidate.workflow.documentGeneration) ||
    (candidate.workflow.freshness !== "current" && candidate.workflow.freshness !== "possibly-stale") ||
    !safeInteger(candidate.workflow.historyBoundary) ||
    (candidate.lifecycle !== "active" && candidate.lifecycle !== "finished" && candidate.lifecycle !== "discarded")) {
    return undefined;
  }
  return closedJsonClone(candidate);
}

function safeChromeScope(value: unknown): unknown | undefined {
  if (!record(value) || Object.keys(value).some((key) => FORBIDDEN_CHROME_KEY.test(key))) return undefined;
  const title = sanitizeReviewRuntimeDisplayString(value.documentTitle);
  if (title === undefined || (value.launchSurface !== undefined && value.launchSurface !== "chrome")) return undefined;
  const sourceDisplayName = value.sourceDisplayName === undefined
    ? undefined
    : sanitizeReviewRuntimeDisplayString(value.sourceDisplayName);
  if (value.sourceDisplayName !== undefined && sourceDisplayName === undefined) return undefined;
  if (value.sourceDisposition !== undefined && value.sourceDisposition !== "local" &&
    value.sourceDisposition !== "remote-temporary") return undefined;
  return {
    documentTitle: title,
    ...(value.sourceDisposition === undefined ? {} : { sourceDisposition: value.sourceDisposition }),
    ...(sourceDisplayName === undefined ? {} : { sourceDisplayName }),
    launchSurface: "chrome",
  };
}

function safeMacosScope(value: unknown): unknown | undefined {
  if (!record(value)) return undefined;
  const candidate = { ...value };
  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_CHROME_KEY.test(key)) delete candidate[key];
  }
  const projected = safeChromeScope({ ...candidate, launchSurface: "chrome" });
  if (!record(projected)) return undefined;
  return { ...projected, launchSurface: "macos" };
}

function safeChromeSaveStatus(value: unknown): unknown | undefined {
  if (!record(value) || !record(value.destination) || !record(value.sync)) return undefined;
  const destination = value.destination;
  let safeDestination: unknown;
  if (destination.phase === "none" && destination.generation === 0) {
    safeDestination = { phase: "none", generation: 0 };
  } else if (destination.phase === "establishing" && safeInteger(destination.generation)) {
    safeDestination = { phase: "establishing", generation: destination.generation };
  } else if (destination.phase === "active" && safeInteger(destination.generation) &&
    (destination.kind === "original" || destination.kind === "copy")) {
    safeDestination = {
      phase: "active", generation: destination.generation, kind: destination.kind, targetPath: "Reviewed PDF",
    };
  } else return undefined;
  if ((value.sync.phase !== "clean" && value.sync.phase !== "saving" && value.sync.phase !== "not-saved") ||
    !safeInteger(value.sync.desiredRevision) || !safeInteger(value.sync.savedRevision) ||
    (value.sync.failure !== undefined &&
      (typeof value.sync.failure !== "string" || !SAVE_FAILURE_REASONS.has(value.sync.failure)))) return undefined;
  let rewriteEligibility: unknown;
  if (value.rewriteEligibility !== undefined) {
    if (!record(value.rewriteEligibility)) return undefined;
    if (value.rewriteEligibility.eligible === true && hasOnlyKeys(value.rewriteEligibility, ["eligible"])) {
      rewriteEligibility = { eligible: true };
    } else if (value.rewriteEligibility.eligible === false &&
      hasOnlyKeys(value.rewriteEligibility, ["eligible", "code", "message"]) &&
      ["encrypted", "permission-denied", "signature-restricted", "invalid-pdf"].includes(
        String(value.rewriteEligibility.code),
      )) {
      rewriteEligibility = {
        eligible: false,
        code: value.rewriteEligibility.code,
        message: "This PDF cannot be rewritten automatically.",
      };
    } else return undefined;
  }
  return {
    destination: safeDestination,
    ...(rewriteEligibility === undefined ? {} : { rewriteEligibility }),
    sync: {
      phase: value.sync.phase,
      desiredRevision: value.sync.desiredRevision,
      savedRevision: value.sync.savedRevision,
      ...(typeof value.sync.failure === "string" ? { failure: value.sync.failure } : {}),
    },
  };
}

export function isSaveDestinationConfirmation(value: unknown): value is SaveDestinationConfirmation {
  return record(value) && hasOnlyKeys(value, ["command", "expectedGeneration"]) &&
    safeInteger(value.expectedGeneration) && record(value.command) &&
    value.command.type === "set-annotation-name" && safeChromeCommand(value.command) !== undefined;
}

/** Returns a fresh, closed payload for the Chrome RPC boundary, or rejects it. */
export function sanitizeChromeReviewRuntimeRequest(
  method: ReviewRuntimeMethod,
  payload: unknown,
): unknown | undefined {
  if (!isReviewRuntimeMethodForHost("chrome", method) || !record(payload)) return undefined;
  if (["bootstrap", "presence", "detach", "saveStatus", "saveProposal", "chooseFolder",
    "retrySave", "locateSave", "scope"].includes(method)) {
    return Object.keys(payload).length === 0 ? {} : undefined;
  }
  if (method === "command") return safeChromeCommand(payload);
  if (method === "chooseOriginal") {
    if (!hasOnlyKeys(payload, ["confirmation"]) ||
      (payload.confirmation !== undefined && !isSaveDestinationConfirmation(payload.confirmation))) return undefined;
    return payload.confirmation === undefined ? {} : { confirmation: closedJsonClone(payload.confirmation) };
  }
  if (method === "chooseCopy") {
    if (!hasOnlyKeys(payload, ["filename", "folderSelectionId", "confirmation"]) ||
      (payload.confirmation !== undefined && !isSaveDestinationConfirmation(payload.confirmation)) ||
      (payload.filename !== undefined && sanitizeReviewRuntimeDisplayString(payload.filename) === undefined) ||
      (payload.folderSelectionId !== undefined &&
        (typeof payload.folderSelectionId !== "string" || !SAFE_RUNTIME_ID.test(payload.folderSelectionId)))) return undefined;
    return {
      ...(payload.filename === undefined ? {} : { filename: sanitizeReviewRuntimeDisplayString(payload.filename) }),
      ...(payload.confirmation === undefined ? {} : { confirmation: closedJsonClone(payload.confirmation) }),
      ...(payload.folderSelectionId === undefined ? {} : { folderSelectionId: payload.folderSelectionId }),
    };
  }
  if (method === "exportReviewedCopy") {
    return hasOnlyKeys(payload, ["confirmPossiblyStale", "fence"]) &&
      (payload.fence === undefined || isReviewExportFence(payload.fence)) &&
      (payload.confirmPossiblyStale === undefined || payload.confirmPossiblyStale === true)
      ? { ...(payload.confirmPossiblyStale === true ? { confirmPossiblyStale: true } : {}),
        ...(payload.fence === undefined ? {} : { fence: closedJsonClone(payload.fence) }) }
      : undefined;
  }
  return undefined;
}

/** Returns a fresh, closed payload for the packaged macOS page/runtime lane. */
export function sanitizeMacosReviewRuntimeRequest(
  method: ReviewRuntimeMethod,
  payload: unknown,
): unknown | undefined {
  if (!isReviewRuntimeMethodForHost("macos", method)) return undefined;
  return sanitizeChromeReviewRuntimeRequest(method, payload);
}

/** Projects trusted service output onto the non-authorizing Chrome client contract. */
export function sanitizeChromeReviewRuntimeResponse(
  method: ReviewRuntimeMethod,
  value: unknown,
): unknown | undefined {
  if (!isReviewRuntimeMethodForHost("chrome", method)) return undefined;
  if (method === "bootstrap") {
    if (!record(value) || !SESSION_ID.test(String(value.sessionId)) || !safeInteger(value.generation) ||
      !safeInteger(value.revision) || !record(value.scope) || !record(value.resources)) return undefined;
    const state = safeChromeState(value.state);
    const scopeInput = { ...value.scope };
    for (const key of Object.keys(scopeInput)) if (FORBIDDEN_CHROME_KEY.test(key)) delete scopeInput[key];
    const scope = safeChromeScope(scopeInput);
    const saveStatus = safeChromeSaveStatus(value.saveStatus);
    const canonicalLinkBase = safeChromeCanonicalLinkBase(value.canonicalLinkBase);
    const location = value.location === undefined ? undefined : safeChromeLocation(value.location);
    const resources = value.resources;
    if (state === undefined || !record(state) || state.sessionId !== value.sessionId ||
      state.revision !== value.revision || !record(state.workflow) ||
      state.workflow.documentGeneration !== value.generation || scope === undefined ||
      saveStatus === undefined || canonicalLinkBase === undefined ||
      (value.location !== undefined && location === undefined) || typeof resources.document !== "string" ||
      typeof resources.pdfiumWasm !== "string" || typeof resources.worker !== "string") return undefined;
    return {
      sessionId: value.sessionId,
      generation: value.generation,
      revision: value.revision,
      state,
      scope,
      saveStatus,
      ...(typeof value.protected === "boolean" ? { protected: value.protected } : {}),
      resources: {
        document: resources.document,
        pdfiumWasm: resources.pdfiumWasm,
        worker: resources.worker,
      },
      canonicalLinkBase,
      ...(location === undefined ? {} : { location }),
    };
  }
  if (method === "scope") return safeChromeScope(value);
  if (["saveStatus", "chooseCopy", "chooseOriginal", "retrySave", "locateSave"].includes(method)) {
    const status = safeChromeSaveStatus(value);
    if (status === undefined || !record(value) || value.nameResult === undefined) return status;
    if (method !== "chooseCopy" && method !== "chooseOriginal") return undefined;
    const nameResult = sanitizeChromeReviewRuntimeResponse("command", value.nameResult);
    return nameResult === undefined ? undefined : { ...status as object, nameResult };
  }
  if (method === "command") {
    if (record(value) && value.accepted === false) {
      const state = safeChromeState(value.state);
      const message = sanitizeReviewRuntimeDisplayString(value.message, 512);
      if (state === undefined || message === undefined) return undefined;
      return {
        accepted: false,
        state,
        message,
        ...(value.reason === "generation-conflict" ? { reason: value.reason } : {}),
      };
    }
    return safeChromeState(value);
  }
  if (method === "saveProposal") {
    if (!record(value) || (value.sourceDisposition !== "local" && value.sourceDisposition !== "remote-temporary")) {
      return undefined;
    }
    if (value.sourceDisposition === "remote-temporary") {
      return hasOnlyKeys(value, ["sourceDisposition"])
        ? { sourceDisposition: "remote-temporary" }
        : undefined;
    }
    const filename = sanitizeReviewRuntimeDisplayString(value.filename);
    if (filename === undefined) return undefined;
    return {
      sourceDisposition: "local",
      filename,
      folder: "Local folder",
    };
  }
  if (method === "chooseFolder") {
    if (!record(value) || typeof value.cancelled !== "boolean") return undefined;
    return {
      cancelled: value.cancelled,
      ...(typeof value.selectionId === "string" && SAFE_RUNTIME_ID.test(value.selectionId)
        ? { selectionId: value.selectionId }
        : {}),
      ...(value.cancelled ? {} : { folder: "Local folder" }),
    };
  }
  if (method === "exportReviewedCopy") {
    if (!record(value) || value.kind !== "reviewed-copy" || !safeInteger(value.revision) ||
      typeof value.digest !== "string" || !SHA256.test(value.digest) ||
      (value.warning !== undefined && value.warning !== COMMITTED_REVIEWED_COPY_WARNING)) return undefined;
    return {
      kind: "reviewed-copy",
      path: "Reviewed PDF",
      revision: value.revision,
      digest: value.digest,
      ...(value.warning === undefined ? {} : { warning: COMMITTED_REVIEWED_COPY_WARNING }),
    };
  }
  return record(value) && Object.keys(value).length === 0 ? {} : undefined;
}

/** Projects trusted service output without paths, capabilities, or link bases.
 * Link construction stays on the trusted helper/native host-action lane. */
export function sanitizeMacosReviewRuntimeResponse(
  method: ReviewRuntimeMethod,
  value: unknown,
): unknown | undefined {
  if (!isReviewRuntimeMethodForHost("macos", method)) return undefined;
  if (method === "scope") return safeMacosScope(value);
  if (method === "bootstrap") {
    if (!record(value) || !record(value.scope)) return undefined;
    const projected = sanitizeChromeReviewRuntimeResponse("bootstrap", {
      ...value,
      scope: { ...value.scope, launchSurface: "chrome" },
      // The Mac page never receives or supplies the path-bearing link base.
      // A fixed inert placeholder lets us reuse the remainder of Chrome's
      // closed bootstrap validator before removing this field below.
      canonicalLinkBase: "placekeeper:///Redacted.pdf",
    });
    if (!record(projected)) return undefined;
    const scope = safeMacosScope(value.scope);
    if (scope === undefined) return undefined;
    const { canonicalLinkBase: _canonicalLinkBase, ...withoutLinkBase } = projected;
    return { ...withoutLinkBase, scope };
  }
  return sanitizeChromeReviewRuntimeResponse(method, value);
}

/** The acknowledged review that the reader approved for export. */
export interface ReviewExportFence {
  readonly expectedRevision: number;
  readonly documentGeneration: number;
}

export function isReviewExportFence(value: unknown): value is ReviewExportFence {
  return record(value) && hasOnlyKeys(value, ["expectedRevision", "documentGeneration"])
    && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0
    && Number.isSafeInteger(value.documentGeneration) && (value.documentGeneration as number) >= 1;
}

export class ReviewExportConflictError extends Error {
  constructor() {
    super("Review changed. Confirm the annotation name again to export the latest review.");
    this.name = "ReviewExportConflictError";
  }
}
