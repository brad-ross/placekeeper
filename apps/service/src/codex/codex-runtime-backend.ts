import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PlacekeeperLinkLocation } from "../../../../packages/core/src/placekeeper-link.js";
import type { CodexAppRequest, CodexResourceDescriptor } from "../../../../packages/core/src/codex-mcp-protocol.js";
import { sanitizeCodexReviewRuntimeResponse, type ReviewRuntimeBrokerMethod } from "../../../../packages/core/src/review-runtime-protocol.js";
import { ChromeRuntimeOperationJournal } from "../browser/runtime-operation-journal.js";
import { LocalReviewBackend } from "../runtime/local-review-backend.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import type { ReviewInteractionAttachment } from "../sessions/review-interactions.js";
import type { PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import type { ExportCoordinator } from "../export/export-coordinator.js";

export interface CodexActiveScope {
  readonly sessionId: string;
  readonly taskSessionId: string;
  readonly runtimeId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly requestedLocation?: PlacekeeperLinkLocation;
}
interface Resource {
  readonly descriptor: CodexResourceDescriptor;
  readonly bytes?: Buffer;
}
interface Presentation {
  readonly scope: CodexActiveScope;
  readonly ownerKey: string;
  readonly attachment: ReviewInteractionAttachment;
  resources?: Record<"document" | "pdfiumWasm" | "worker", Resource>;
  materializing?: Promise<Record<"document" | "pdfiumWasm" | "worker", Resource>>;
}
const effects = new Set(["command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy"]);

/** Trusted native effects and immutable resource handles. No path or service
 * credential crosses this boundary; the caller fences authority around awaits. */
export class CodexServiceRuntimeBackend {
  readonly #broker: SessionBroker;
  readonly #saving: PdfSaveCoordinator;
  readonly #review: LocalReviewBackend;
  readonly #assetRoot: string | undefined;
  readonly #presentations = new Map<string, Presentation>();
  readonly #activeRequests = new Map<string, number>();
  readonly #journal: ChromeRuntimeOperationJournal;

  constructor(options: {
    readonly broker: SessionBroker;
    readonly saving: PdfSaveCoordinator;
    readonly exporting: ExportCoordinator;
    readonly assetRoot?: string;
  }) {
    this.#broker = options.broker;
    this.#saving = options.saving;
    this.#review = new LocalReviewBackend(options);
    this.#assetRoot = options.assetRoot;
    this.#journal = new ChromeRuntimeOperationJournal({ scope: (sessionId) => {
      if (this.#broker.state(sessionId) === undefined) throw new Error("canonical-review-unavailable");
      return { directory: join(this.#broker.recoveryRoot, sessionId), prefix: "codex" };
    } });
  }

  attach(scope: CodexActiveScope): void {
    const ownerKey = `codex:${scope.runtimeId}`;
    this.#presentations.set(scope.runtimeId, {
      scope, ownerKey,
      attachment: this.#broker.replaceInteractionAttachment(scope.sessionId, ownerKey),
    });
  }

  detach(runtimeId: string): void {
    const record = this.#presentations.get(runtimeId);
    if (record === undefined) return;
    this.#presentations.delete(runtimeId);
    this.#broker.disconnectInteractionIncarnation(record.scope.sessionId, record.ownerKey, record.attachment);
    this.#releaseInactiveJournal(record.scope.sessionId);
  }

  #releaseInactiveJournal(sessionId: string): void {
    if (this.#activeRequests.has(sessionId)) return;
    if ([...this.#presentations.values()].some((peer) => peer.scope.sessionId === sessionId)) return;
    this.#journal.releaseCanonical(sessionId);
  }

  retentionStatus() {
    return {
      presentations: this.#presentations.size,
      resources: [...this.#presentations.values()].reduce((count, record) => count + (record.resources === undefined ? 0 : 3), 0),
      ...this.#journal.retentionStatus(),
    };
  }

  async handle(scope: CodexActiveScope, request: Extract<CodexAppRequest, { authority: "presentation" }>, current: () => boolean): Promise<unknown> {
    this.#activeRequests.set(scope.sessionId, (this.#activeRequests.get(scope.sessionId) ?? 0) + 1);
    try {
      return await this.#handle(scope, request, current);
    } finally {
      const remaining = this.#activeRequests.get(scope.sessionId)! - 1;
      if (remaining === 0) this.#activeRequests.delete(scope.sessionId);
      else this.#activeRequests.set(scope.sessionId, remaining);
      // A durable disk replay can populate the journal after the last panel
      // detached. Retire it only once every admitted request has settled.
      this.#releaseInactiveJournal(scope.sessionId);
    }
  }

  async #handle(scope: CodexActiveScope, request: Extract<CodexAppRequest, { authority: "presentation" }>, current: () => boolean): Promise<unknown> {
    const record = this.#presentations.get(scope.runtimeId);
    if (record === undefined || record.scope.attemptId !== scope.attemptId || record.scope.generation !== scope.generation) throw new Error("presentation-unavailable");
    if (request.method === "bootstrap") {
      const resources = await this.#resources(record);
      if (!current()) throw new Error("presentation-unavailable");
      const runtime = await this.#broker.runtimeState(scope.sessionId);
      const scopeValue = await this.#broker.sessionScope(scope.sessionId);
      const projected = sanitizeCodexReviewRuntimeResponse("bootstrap", {
        sessionId: scope.sessionId, generation: scope.generation, revision: runtime?.state.revision,
        state: runtime?.state, activeAuthoringDraftIds: runtime?.activeAuthoringDraftIds,
        scope: scopeValue, saveStatus: this.#broker.saveStatus(scope.sessionId),
        protected: this.#broker.chromeProtected(scope.sessionId),
        ...(record.scope.requestedLocation === undefined ? {} : { location: record.scope.requestedLocation }),
        resources: Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, resource.descriptor.handle])),
      });
      if (projected === undefined) throw new Error("invalid-service-response");
      return {
        ...projected as object,
        resourceDescriptors: Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, resource.descriptor])),
        interaction: record.attachment,
        capabilities: { localDocumentRefresh: false, interactionLifecycleVersion: 1 },
      };
    }
    if (request.method === "resource") {
      const value = request.payload as { handle: string; offset: number; length: number };
      const resource = Object.values(record.resources ?? {}).find((candidate) => candidate.descriptor.handle === value.handle);
      if (resource === undefined || value.offset >= resource.descriptor.byteLength) throw new Error("invalid-resource");
      const length = Math.min(value.length, resource.descriptor.byteLength - value.offset);
      const bytes = resource.bytes === undefined
        ? await this.#broker.documentRange(scope.sessionId, scope.generation, value.offset, length)
        : resource.bytes.subarray(value.offset, value.offset + length);
      if (bytes === undefined || bytes.length !== length) throw new Error("resource-unavailable");
      return { offset: value.offset, dataBase64: bytes.toString("base64"), done: value.offset + length === resource.descriptor.byteLength };
    }
    if (request.method === "presence") return {};
    const method = request.method as ReviewRuntimeBrokerMethod;
    const interactionAction = method === "beginInteraction" ? "begin"
      : method === "finalizeInteraction" ? "finalize"
        : method === "releaseInteraction" ? "release"
          : method === "acknowledgeInteraction" ? "acknowledge" : undefined;
    const invoke = async () => {
      if (!current()) throw new Error("presentation-unavailable");
      const result = interactionAction !== undefined
        ? await this.#review.interaction(scope.sessionId, record.attachment, interactionAction, request.payload)
        : method === "saveProposal" ? this.#saving.proposal(scope.sessionId)
          : await this.#review.invoke(scope.sessionId, scope.generation, method as Exclude<ReviewRuntimeBrokerMethod, "saveProposal">, request.payload, { expectedDocumentGeneration: scope.generation });
      const projected = sanitizeCodexReviewRuntimeResponse(method, result);
      if (projected === undefined) throw new Error("invalid-service-response");
      return projected;
    };
    // Finalization uses canonical persisted receipts, whose outcome must remain
    // recoverable independently of this adapter's operation journal.
    return effects.has(method)
      ? this.#journal.commit(scope.sessionId, request.requestId, { generation: scope.generation, method, payload: request.payload }, invoke)
      : invoke();
  }

  #resources(record: Presentation): Promise<Record<"document" | "pdfiumWasm" | "worker", Resource>> {
    if (record.resources !== undefined) return Promise.resolve(record.resources);
    record.materializing ??= (async () => {
      if (this.#assetRoot === undefined) throw new Error("native-assets-unavailable");
      const root = await realpath(this.#assetRoot);
      const asset = async (name: string, mediaType: "application/wasm" | "text/javascript"): Promise<Resource> => {
        const path = await realpath(join(root, name));
        if (!path.startsWith(`${root}${sep}`)) throw new Error("native-assets-unavailable");
        const bytes = await readFile(path);
        if (bytes.length === 0) throw new Error("native-assets-unavailable");
        return { bytes, descriptor: { handle: randomBytes(16).toString("base64url"), byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"), mediaType } };
      };
      const [pdfiumWasm, worker] = await Promise.all([asset("pdfium.wasm", "application/wasm"), asset("pdfium-worker.js", "text/javascript")]);
      const state = this.#broker.state(record.scope.sessionId);
      if (this.#presentations.get(record.scope.runtimeId) !== record || state?.workflow.documentGeneration !== record.scope.generation) throw new Error("presentation-unavailable");
      const document: Resource = { descriptor: { handle: randomBytes(16).toString("base64url"), byteLength: state.source.byteLength,
        sha256: state.source.digest, mediaType: "application/pdf" } };
      record.resources = { document, pdfiumWasm, worker };
      return record.resources;
    })().catch((error) => { delete record.materializing; throw error; });
    return record.materializing;
  }
}
