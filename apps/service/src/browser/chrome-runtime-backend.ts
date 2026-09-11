import type { SaveDestinationConfirmation } from "../../../../packages/core/src/review-model.js";
import { rejectedDestinationName } from "../saving/pdf-save-coordinator.js";
import type { ReviewCommand } from "../../../../packages/core/src/review-model.js";
import { join } from "node:path";
import type { ReviewRuntimeBrokerMethod } from "../../../../packages/core/src/review-runtime-protocol.js";
import type { ExportCoordinator } from "../export/export-coordinator.js";
import type { PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import type { SessionBroker, SessionLaunch } from "../sessions/session-broker.js";
import type { BrowserSourceStore } from "./browser-source-store.js";
import { CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION } from "./browser-source-store.js";
import {
  ChromeCanonicalReviewIndex,
  ChromeRuntimeAggregateQuota,
  ChromeRuntimeServiceAuthority,
  ChromeRuntimeOperationJournal,
  type ChromeRuntimeBackend,
  type ChromeRuntimeProjection,
  type ChromeRuntimeRecovery,
  type ChromeRuntimeSourceSink,
  type ChromeRuntimeStageRequest,
} from "./chrome-runtime.js";
import {
  ChromeTransferStore,
  type SealedBrowserSourceHandle,
} from "./chrome-handoff.js";

interface CanonicalRecord {
  readonly indexKey: string;
  readonly sessionId: string;
  generation: number;
  sha256: string;
  byteLength: number;
  readonly discardIfUnactivated: boolean;
}

export interface ChromeServiceRuntimeBackendOptions {
  readonly broker: SessionBroker;
  readonly browserSources: BrowserSourceStore;
  readonly transferStore: ChromeTransferStore;
  readonly saving: PdfSaveCoordinator;
  readonly exporting: ExportCoordinator;
  readonly quota?: ChromeRuntimeAggregateQuota;
  readonly runtimeHost?: "chrome" | "macos";
}

/** Disk-backed adapter from the Chrome runtime protocol to existing service
 * authority. It retains credentials, paths, source URLs, and presentation
 * leases exclusively on the trusted side. */
export class ChromeServiceRuntimeBackend implements ChromeRuntimeBackend {
  readonly #broker: SessionBroker;
  readonly #browserSources: BrowserSourceStore;
  readonly #transferStore: ChromeTransferStore;
  readonly #saving: PdfSaveCoordinator;
  readonly #exporting: ExportCoordinator;
  readonly #index = new ChromeCanonicalReviewIndex<CanonicalRecord | ChromeRuntimeRecovery>();
  readonly #records = new Map<string, CanonicalRecord>();
  readonly #presentations = new Map<string, Set<string>>();
  readonly #provisionals = new Map<string, number>();
  readonly #activated = new Set<string>();
  readonly #runtimeHost: "chrome" | "macos";
  readonly #journal: ChromeRuntimeOperationJournal;

  constructor(options: ChromeServiceRuntimeBackendOptions) {
    this.#broker = options.broker;
    this.#browserSources = options.browserSources;
    this.#transferStore = options.transferStore;
    this.#saving = options.saving;
    this.#exporting = options.exporting;
    this.#runtimeHost = options.runtimeHost ?? "chrome";
    this.#journal = new ChromeRuntimeOperationJournal({
      root: join(this.#broker.recoveryRoot, `.${this.#runtimeHost}-operations`),
      scope: (canonicalKey) => {
        const record = this.#record(canonicalKey);
        this.#refreshRecord(record);
        if (this.#broker.canonicalLinkBase(record.sessionId) === undefined) throw new Error("canonical-review-unavailable");
        return {
          directory: join(this.#broker.recoveryRoot, record.sessionId),
          prefix: this.#runtimeHost,
          legacyCanonicalKey: record.indexKey,
        };
      },
    });
    this.#broker.onSessionEnd((sessionId) => {
      for (const [canonicalKey, record] of this.#records) {
        if (record.sessionId === sessionId) this.#forgetCanonical(canonicalKey, record);
      }
    });
  }

  authority(quota?: ChromeRuntimeAggregateQuota): ChromeRuntimeServiceAuthority {
    return new ChromeRuntimeServiceAuthority(this, {
      quota: quota ?? new ChromeRuntimeAggregateQuota(),
      journal: this.#journal,
    });
  }

  retentionStatus(): {
    readonly records: number; readonly activated: number; readonly presentations: number;
    readonly provisionals: number; readonly cachedOperations: number; readonly indexedReviews: number;
  } {
    return {
      records: this.#records.size, activated: this.#activated.size,
      indexedReviews: this.#index.size,
      presentations: this.#presentations.size, provisionals: this.#provisionals.size,
      cachedOperations: this.#journal.retentionStatus().cachedOperations,
    };
  }

  #forgetCanonical(canonicalKey: string, record: CanonicalRecord): void {
    this.#records.delete(canonicalKey);
    this.#index.delete(record.indexKey);
    this.#presentations.delete(canonicalKey);
    this.#provisionals.delete(canonicalKey);
    this.#activated.delete(canonicalKey);
    this.#journal.releaseCanonical(canonicalKey);
  }

  async begin(request: ChromeRuntimeStageRequest): Promise<ChromeRuntimeSourceSink> {
    if (request.disposition === "local") return this.#localSink(request);
    const staged = await this.#transferStore.begin(request.displayName);
    let finished = false;
    return {
      append: (bytes) => this.#transferStore.append(staged, bytes),
      finish: async (claim) => {
        if (finished || claim === undefined) throw new Error("invalid-source-claim");
        finished = true;
        const handle = await this.#transferStore.seal(staged);
        const source = await this.#transferStore.inspect(handle);
        if (source.sha256 !== claim.sha256 || source.byteLength !== claim.byteLength) {
          await this.#transferStore.remove(handle);
          throw new Error("source-integrity");
        }
        const resolution = await this.#index.resolve(
          { sourceIdentity: request.sourceIdentity, sha256: source.sha256, generation: 1 },
          async () => this.#openRemote(handle, request.sourceIdentity, source),
        ).finally(() => this.#transferStore.remove(handle));
        if ("choose" in resolution.review) {
          this.#index.delete(resolution.canonicalKey);
          return resolution.review;
        }
        return this.#stageRecord(resolution.canonicalKey, resolution.review);
      },
      cancel: async () => {
        if (!finished) await this.#transferStore.cancel(staged);
      },
    };
  }

  async activate(canonicalKey: string, presentationLease: string): Promise<ChromeRuntimeProjection> {
    const record = this.#record(canonicalKey);
    const projection = await this.#projection(record);
    this.#refreshRecord(this.#record(canonicalKey));
    const provisionalCount = Math.max(0, (this.#provisionals.get(canonicalKey) ?? 1) - 1);
    if (provisionalCount === 0) this.#provisionals.delete(canonicalKey);
    else this.#provisionals.set(canonicalKey, provisionalCount);
    const presentations = this.#presentations.get(canonicalKey) ?? new Set<string>();
    presentations.add(presentationLease);
    this.#activated.add(canonicalKey);
    this.#presentations.set(canonicalKey, presentations);
    return projection;
  }

  current(canonicalKey: string): Promise<ChromeRuntimeProjection> {
    return this.#projection(this.#record(canonicalKey));
  }

  async invoke(
    canonicalKey: string,
    method: ReviewRuntimeBrokerMethod,
    payload: unknown,
    _operation: { readonly idempotencyKey?: string; readonly payloadDigest: string },
  ): Promise<unknown> {
    const record = this.#record(canonicalKey);
    this.#refreshRecord(record);
    if (["command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy"].includes(method)) {
      // Establish the durable recovery boundary before attempting a side
      // effect. A rejected operation may conservatively retain a clean draft;
      // a committed operation can never lose its protection marker.
      await this.#broker.protectChromeReview(record.sessionId);
    }
    let result: unknown;
    switch (method) {
      case "command":
        result = await this.#broker.acceptMutation(record.sessionId, payload as ReviewCommand, { expectedGeneration: record.generation });
        if (this.#broker.saveStatus(record.sessionId)?.destination.phase === "active") {
          void this.#saving.requestSave(record.sessionId);
        }
        break;
      case "saveStatus": result = this.#broker.saveStatus(record.sessionId); break;
      case "saveProposal": result = this.#saving.proposal(record.sessionId); break;
      case "chooseCopy":
      case "chooseOriginal": {
        const value = payload as { readonly filename?: string; readonly folderSelectionId?: string;
          readonly confirmation?: SaveDestinationConfirmation };
        let nameResult;
        try {
          const state = method === "chooseCopy"
            ? await this.#saving.chooseCopyFilename(record.sessionId, value.filename, value.folderSelectionId, value.confirmation)
            : await this.#saving.chooseOriginal(record.sessionId, value.confirmation);
          if (value.confirmation !== undefined) nameResult = state;
        } catch (error) {
          if (value.confirmation === undefined) throw error;
          nameResult = rejectedDestinationName(error, this.#broker.state(record.sessionId));
          if (nameResult === undefined) throw error;
        }
        result = { ...this.#broker.saveStatus(record.sessionId),
          ...(nameResult === undefined ? {} : { nameResult }),
        };
        break;
      }
      case "chooseFolder": result = await this.#saving.chooseFolder(record.sessionId); break;
      case "retrySave":
        await this.#saving.retry(record.sessionId);
        result = this.#broker.saveStatus(record.sessionId);
        break;
      case "locateSave":
        await this.#saving.locate(record.sessionId);
        result = this.#broker.saveStatus(record.sessionId);
        break;
      case "scope": result = await this.#broker.sessionScope(record.sessionId); break;
      case "exportReviewedCopy": {
        const value = payload as { readonly confirmPossiblyStale?: true };
        const frozen = await this.#broker.freezeDelivery(record.sessionId);
        result = await this.#exporting.exportReviewedCopy({
          ...frozen,
          ...(value.confirmPossiblyStale === true ? { staleConfirmed: true as const } : {}),
        });
        break;
      }
      default: throw new Error("chrome-method-forbidden");
    }
    this.#refreshRecord(record);
    return result;
  }

  async readDocument(canonicalKey: string, generation: number, offset: number, length: number): Promise<Buffer> {
    const record = this.#record(canonicalKey);
    this.#refreshRecord(record);
    if (generation !== record.generation || offset < 0 || length < 1) throw new Error("stale-generation");
    const bytes = await this.#broker.documentRange(record.sessionId, generation, offset, length);
    if (bytes === undefined) throw new Error("source-unavailable");
    return bytes;
  }

  async detach(canonicalKey: string, presentationLease: string): Promise<void> {
    const presentations = this.#presentations.get(canonicalKey);
    presentations?.delete(presentationLease);
    if (presentations?.size === 0) this.#presentations.delete(canonicalKey);
  }

  async release(canonicalKey: string): Promise<void> {
    const record = this.#records.get(canonicalKey);
    const provisionalCount = Math.max(0, (this.#provisionals.get(canonicalKey) ?? 1) - 1);
    if (provisionalCount === 0) this.#provisionals.delete(canonicalKey);
    else this.#provisionals.set(canonicalKey, provisionalCount);
    if (record?.discardIfUnactivated === true && !this.#activated.has(canonicalKey) && provisionalCount === 0 &&
      (this.#presentations.get(canonicalKey)?.size ?? 0) === 0) {
      await this.#broker.discard(record.sessionId).catch(() => undefined);
      this.#forgetCanonical(canonicalKey, record);
    }
  }

  #record(canonicalKey: string): CanonicalRecord {
    const record = this.#records.get(canonicalKey);
    if (record === undefined) throw new Error("canonical-review-unavailable");
    return record;
  }

  #refreshRecord(record: CanonicalRecord): void {
    const state = this.#broker.state(record.sessionId);
    if (state === undefined) throw new Error("canonical-review-unavailable");
    record.generation = state.workflow.documentGeneration;
    record.sha256 = state.source.digest;
    record.byteLength = state.source.byteLength;
  }

  async #localSink(request: ChromeRuntimeStageRequest): Promise<ChromeRuntimeSourceSink> {
    const fileUrl = request.fileUrl!;
    let finished = false;
    return {
      append: async () => { throw new Error("local-source-does-not-accept-chunks"); },
      finish: async () => {
        if (finished) throw new Error("source-already-finished");
        finished = true;
        const canonicalPath = await this.#transferStore.canonicalizeLocal(fileUrl);
        const opened = await this.#broker.openReview({ pdfPath: canonicalPath, surface: this.#runtimeHost });
        if (opened.kind === "recovery-offered") {
          return {
            choices: ["resume", "discard", "fork"],
            offer: opened.recoveryOffer,
            choose: async (decision, operationId) => {
              const recovered = await this.#broker.openReview({
                pdfPath: canonicalPath,
                surface: this.#runtimeHost,
                recoveryDecision: decision,
                recoveryOffer: opened.recoveryOffer,
                recoveryOperationId: operationId,
              });
              if (recovered.kind === "recovery-offered") throw new Error("recovery-offer-unavailable");
              const record = await this.#recordFromLaunch(
                recovered.launch,
                recovered.kind === "opened" && decision !== "resume",
              );
              const canonicalKey = `${request.sourceIdentity}:${record.sha256}:${record.generation}`;
              return this.#stageRecord(canonicalKey, record);
            },
          } satisfies ChromeRuntimeRecovery;
        }
        const record = await this.#recordFromLaunch(opened.launch, opened.kind === "opened");
        const canonicalKey = `${request.sourceIdentity}:${record.sha256}:${record.generation}`;
        return this.#stageRecord(canonicalKey, record);
      },
      cancel: async () => undefined,
    };
  }

  async #openRemote(
    handle: SealedBrowserSourceHandle,
    sourceIdentity: string,
    source: { readonly sha256: string; readonly byteLength: number; readonly displayName?: string },
  ): Promise<CanonicalRecord | ChromeRuntimeRecovery> {
    const opened = await this.#broker.openChromeBrowserSource({
      protocolVersion: CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION,
      sourceHandle: handle,
      sourceIdentity,
      byteLength: source.byteLength,
      sha256: source.sha256,
      ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    }, this.#browserSources);
    if (opened.kind === "recovery-offered") {
      const recoveryPath = join(this.#broker.recoveryRoot, opened.recoverySessionId, "source.pdf");
      return {
        choices: ["resume", "discard", "fork"],
        offer: opened.recoveryOffer,
        choose: async (decision, operationId) => {
          const recovered = await this.#broker.openReview({
            pdfPath: recoveryPath,
            surface: "chrome",
            recoveryDecision: decision,
            recoveryOffer: opened.recoveryOffer,
            recoveryOperationId: operationId,
          });
          if (recovered.kind === "recovery-offered") throw new Error("recovery-offer-unavailable");
          const record = await this.#recordFromLaunch(
            recovered.launch,
            recovered.kind === "opened" && decision !== "resume",
          );
          const canonicalKey = `${sourceIdentity}:${record.sha256}:${record.generation}`;
          return this.#stageRecord(canonicalKey, record);
        },
      };
    }
    return this.#recordFromLaunch(opened.launch, opened.kind === "opened");
  }

  async #recordFromLaunch(launch: SessionLaunch, discardIfUnactivated: boolean): Promise<CanonicalRecord> {
    const capability = new URLSearchParams(launch.fragment.slice(1)).get("cap");
    const credential = capability === null ? undefined : this.#broker.exchangeBootstrap(launch.sessionId, capability);
    const state = this.#broker.state(launch.sessionId);
    if (credential === undefined || state === undefined) throw new Error("bootstrap-unavailable");
    this.#broker.revokePresentationCredential(launch.sessionId, credential);
    return {
      indexKey: "pending", sessionId: launch.sessionId,
      generation: state.workflow.documentGeneration, sha256: state.source.digest,
      byteLength: state.source.byteLength, discardIfUnactivated,
    };
  }

  async #stageRecord(
    indexKey: string,
    record: CanonicalRecord,
  ): Promise<{ readonly canonicalKey: string; readonly projection: ChromeRuntimeProjection }> {
    // Source identity joins presentations only within one review lifetime.
    // A later review of identical bytes must not accept the old connection's key.
    const canonicalKey = `${indexKey}:${record.sessionId}`;
    const staged = { ...record, indexKey };
    try {
      this.#refreshRecord(staged);
    } catch (error) {
      this.#index.delete(indexKey);
      throw error;
    }
    this.#records.set(canonicalKey, staged);
    this.#provisionals.set(canonicalKey, (this.#provisionals.get(canonicalKey) ?? 0) + 1);
    try {
      const projection = await this.#projection(staged);
      this.#refreshRecord(this.#record(canonicalKey));
      return { canonicalKey, projection };
    } catch (error) {
      await this.release(canonicalKey);
      throw error;
    }
  }

  async #projection(record: CanonicalRecord): Promise<ChromeRuntimeProjection> {
    this.#refreshRecord(record);
    const state = this.#broker.state(record.sessionId);
    const scope = await this.#broker.sessionScope(record.sessionId);
    const saveStatus = this.#broker.saveStatus(record.sessionId);
    const canonicalLinkBase = this.#broker.canonicalLinkBase(record.sessionId);
    if (state === undefined || scope === undefined || saveStatus === undefined || canonicalLinkBase === undefined) {
      throw new Error("canonical-review-unavailable");
    }
    return {
      sessionId: record.sessionId,
      generation: state.workflow.documentGeneration,
      revision: state.revision,
      state,
      scope,
      saveStatus,
      canonicalLinkBase,
      protected: this.#broker.chromeProtected(record.sessionId),
      location: { kind: "page", page: 1 },
      document: { sha256: state.source.digest, byteLength: state.source.byteLength, generation: state.workflow.documentGeneration },
    };
  }
}
