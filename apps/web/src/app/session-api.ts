import type { SaveDestinationResult } from "../host/session-contracts.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  ProductionSession,
  ProductionSessionApi,
  ProductionScope,
  ProductionExportResult,
  SaveCopyProposal,
} from "../host/session-contracts.js";
import type { RejectedReviewCommand } from "../review/review-command-result.js";

export type ReopenRecoveryChoice = "resume" | "discard" | "fork";

export interface ReopenRecoveryOffer {
  readonly id: string;
  readonly expiresAt: string;
}

export type ReopenProductionResult =
  | { readonly kind: "opened" | "focused"; readonly url: string }
  | { readonly kind: "confirmation-required"; readonly path: string }
  | { readonly kind: "recovery-refresh-required" }
  | {
      readonly kind: "recovery-offered";
      readonly choices: readonly ReopenRecoveryChoice[];
      readonly recoveryOffer: ReopenRecoveryOffer;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBootstrapUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const target = new URL(value);
    const currentOrigin = globalThis.location?.origin;
    return currentOrigin !== undefined && target.href === value && target.origin === currentOrigin
      && target.username === "" && target.password === ""
      && target.search.length === 0
      && /^\/s\/[A-Za-z0-9_-]+\/bootstrap$/u.test(target.pathname)
      && /^#cap=[A-Za-z0-9_-]+$/u.test(target.hash)
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
}

function validRecoveryOffer(value: unknown): ReopenRecoveryOffer | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "expiresAt" || keys[1] !== "id") return undefined;
  if (
    typeof value.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.id) ||
    typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
  ) return undefined;
  return { id: value.id, expiresAt: value.expiresAt };
}

export async function reopenProductionSession(
  viewId: string,
  link: string,
  options: {
    readonly confirmed?: true;
    readonly recovery?: ReopenRecoveryChoice;
    readonly recoveryOffer?: ReopenRecoveryOffer;
    readonly recoveryOperationId?: string;
  } = {},
): Promise<ReopenProductionResult> {
  if (!/^[0-9a-f-]{36}$/u.test(viewId)) {
    throw new Error("The live review address is invalid.");
  }
  const response = await fetch(`/r/${viewId}/reopen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link, ...options }),
  });
  if (response.status === 409) {
    const rejected: unknown = await response.json().catch(() => undefined);
    if (
      isObject(rejected) && rejected.ok === false && isObject(rejected.error) &&
      rejected.error.kind === "recovery-offer-unavailable"
    ) {
      return { kind: "recovery-refresh-required" };
    }
  }
  if (!response.ok) throw new Error("The reopen request was rejected.");
  const result: unknown = await response.json();
  if (!isObject(result) || result.ok !== true) {
    throw new Error("The PDF could not be reopened.");
  }
  if (result.kind === "opened" || result.kind === "focused") {
    const url = validBootstrapUrl(result.url);
    if (url === undefined) throw new Error("The reopen address is invalid.");
    return { kind: result.kind, url };
  }
  if (result.kind === "confirmation-required" && typeof result.path === "string") {
    return { kind: result.kind, path: result.path };
  }
  if (result.kind === "recovery-offered" && Array.isArray(result.choices)) {
    const expected = new Set<ReopenRecoveryChoice>(["resume", "discard", "fork"]);
    const valid = result.choices.length === expected.size && result.choices.every(
      (choice) => typeof choice === "string" && expected.delete(choice as ReopenRecoveryChoice),
    ) && expected.size === 0;
    const recoveryOffer = validRecoveryOffer(result.recoveryOffer);
    if (valid && recoveryOffer !== undefined) {
      return {
        kind: result.kind,
        choices: ["resume", "discard", "fork"],
        recoveryOffer,
      };
    }
  }
  throw new Error("The PDF could not be reopened.");
}

export async function resumeProductionSession(
  viewId: string,
  pathname: string,
): Promise<ProductionSession> {
  if (!/^[0-9a-f-]{36}$/u.test(viewId)) {
    throw new Error("The live review address is invalid.");
  }
  const response = await fetch(`/r/${viewId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathname }),
  });
  if (!response.ok) {
    throw new Error("This live review is no longer available.");
  }
  return Object.freeze(await response.json() as ProductionSession);
}

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
    if (!response.ok) {
      if (path === "/export" && response.status === 409) {
        const rejected = await response.json().catch(() => undefined) as { error?: { kind?: string } } | undefined;
        if (rejected?.error?.kind === "export-conflict") {
          throw new Error("Review changed. Confirm the annotation name again to export the latest review.");
        }
      }
      throw new Error(`The local review action failed safely (${response.status}).`);
    }
    return response.json() as Promise<T>;
  };
  const post = <T>(path: string, body: unknown = {}) => request<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { request, post };
}

function maintainPresence(session: ProductionSession): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 1_000;
  const connect = (): void => {
    if (stopped) return;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(
      `${scheme}//${window.location.host}/s/${session.sessionId}/control`,
      ["placekeeper", `placekeeper-auth.${session.credential}`],
    );
    socket.addEventListener("open", () => {
      retryDelayMs = 1_000;
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      const delay = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      retry = setTimeout(connect, delay);
    });
  };
  connect();
  return () => {
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    socket?.close();
  };
}

export async function loadProductionSession(session: ProductionSession): Promise<{
  readonly state: ReviewState;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly saveStatus: SaveStatus;
}> {
  const { request, post } = client(session);
  const [state, scope, saveStatus] = await Promise.all([
    request<ReviewState>("/state"),
    request<ProductionScope>("/scope"),
    request<SaveStatus>("/save/status"),
  ]);
  let commandGeneration = state.workflow.documentGeneration;
  return {
    state,
    scope,
    saveStatus,
    api: {
      presence: () => maintainPresence(session),
      command: async (command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> => {
        const response = await fetch(`/s/${session.sessionId}/commands`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.credential}`,
            "content-type": "application/json",
            "x-placekeeper-generation": String(commandGeneration),
          },
          body: JSON.stringify(command),
        });
        if (response.status === 409) {
          const rejected: unknown = await response.json().catch(() => undefined);
          const generationConflict = isObject(rejected) && rejected.ok === false &&
            isObject(rejected.error) && rejected.error.kind === "generation-conflict";
          const currentState = await request<ReviewState>("/state");
          commandGeneration = currentState.workflow.documentGeneration;
          return {
            accepted: false,
            state: currentState,
            message: generationConflict
              ? "The PDF was rebuilt before this command could be applied. The current generation is shown; review it and retry explicitly."
              : "Another review window changed this draft. The latest saved revision is shown; retry your command.",
            ...(generationConflict ? { reason: "generation-conflict" as const } : {}),
          };
        }
        if (response.status === 422) {
          const rejected: unknown = await response.json().catch(() => undefined);
          if (
            isObject(rejected) && rejected.ok === false &&
            isObject(rejected.error) &&
            rejected.error.kind === "invalid-review-command" &&
            typeof rejected.error.message === "string" &&
            rejected.error.message.length > 0 && rejected.error.message.length <= 512
          ) {
            return {
              accepted: false,
              state: await request<ReviewState>("/state"),
              message: rejected.error.message,
              reason: "rejected",
            };
          }
        }
        if (!response.ok) throw new Error(`The local review action failed safely (${response.status}).`);
        const nextState = await response.json() as ReviewState;
        commandGeneration = nextState.workflow.documentGeneration;
        return nextState;
      },
      saveStatus: () => request<SaveStatus>("/save/status"),
      saveProposal: () => request<SaveCopyProposal>("/save/proposal"),
      chooseCopy: (filename, folderSelectionId, confirmation) => post<SaveDestinationResult>(
        "/save/copy",
        {
          ...(filename === undefined ? {} : { filename }),
          ...(folderSelectionId === undefined ? {} : { folderSelectionId }),
          ...(confirmation === undefined ? {} : { confirmation }),
        },
      ),
      chooseFolder: () => post("/save/folder"),
      chooseOriginal: (confirmation) => post<SaveDestinationResult>("/save/original", confirmation === undefined ? {} : { confirmation }),
      retrySave: () => post<SaveStatus>("/save/retry"),
      locateSave: () => post<SaveStatus>("/save/locate"),
      exportReviewedCopy: (confirmPossiblyStale, fence) => post<ProductionExportResult>(
        "/export",
        { ...(confirmPossiblyStale === true ? { confirmPossiblyStale: true } : {}),
        ...(fence === undefined ? {} : { fence }) },
      ),
      scope: (signal) => request<ProductionScope>(
        "/scope",
        signal === undefined ? {} : { signal },
      ),
    },
  };
}
