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
  type ChromeRuntimeSourceSink,
  type ChromeRuntimeStageRequest,
} from "./chrome-runtime.js";
import {
  ChromeTransferStore,
  type SealedBrowserSourceHandle,
} from "./chrome-handoff.js";

interface CanonicalRecord {
  readonly canonicalKey: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly generation: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly created: boolean;
}

export interface ChromeServiceRuntimeBackendOptions {
  readonly broker: SessionBroker;
  readonly browserSources: BrowserSourceStore;
  readonly transferStore: ChromeTransferStore;
  readonly saving: PdfSaveCoordinator;
  readonly exporting: ExportCoordinator;
  readonly quota?: ChromeRuntimeAggregateQuota;
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
  readonly #index = new ChromeCanonicalReviewIndex<CanonicalRecord>();
  readonly #records = new Map<string, CanonicalRecord>();
  readonly #presentations = new Map<string, Set<string>>();
  readonly #provisionals = new Map<string, number>();
  readonly #activated = new Set<string>();

  constructor(options: ChromeServiceRuntimeBackendOptions) {
    this.#broker = options.broker;
    this.#browserSources = options.browserSources;
    this.#transferStore = options.transferStore;
    this.#saving = options.saving;
    this.#exporting = options.exporting;
  }

  authority(quota?: ChromeRuntimeAggregateQuota): ChromeRuntimeServiceAuthority {
    return new ChromeRuntimeServiceAuthority(this, {
      quota: quota ?? new ChromeRuntimeAggregateQuota(),
      journal: new ChromeRuntimeOperationJournal({
        root: join(this.#broker.recoveryRoot, ".chrome-operations"),
      }),
    });
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
        this.#records.set(resolution.canonicalKey, resolution.review);
        this.#provisionals.set(
          resolution.canonicalKey,
          (this.#provisionals.get(resolution.canonicalKey) ?? 0) + 1,
        );
        try {
          return {
            canonicalKey: resolution.canonicalKey,
            projection: await this.#projection(resolution.review),
          };
        } catch (error) {
          await this.release(resolution.canonicalKey);
          throw error;
        }
      },
      cancel: async () => {
        if (!finished) await this.#transferStore.cancel(staged);
      },
    };
  }

  async activate(canonicalKey: string, presentationLease: string): Promise<ChromeRuntimeProjection> {
    const record = this.#record(canonicalKey);
    const projection = await this.#projection(record);
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
    switch (method) {
      case "command":
        return this.#broker.acceptMutation(record.sessionId, payload as ReviewCommand, { expectedGeneration: record.generation });
      case "saveStatus": return this.#broker.saveStatus(record.sessionId);
      case "saveProposal": return this.#saving.proposal(record.sessionId);
      case "chooseCopy": {
        const value = payload as { readonly filename?: string; readonly folderSelectionId?: string };
        await this.#saving.chooseCopyFilename(record.sessionId, value.filename, value.folderSelectionId);
        return this.#broker.saveStatus(record.sessionId);
      }
      case "chooseFolder": return this.#saving.chooseFolder(record.sessionId);
      case "chooseOriginal":
        await this.#saving.chooseOriginal(record.sessionId);
        return this.#broker.saveStatus(record.sessionId);
      case "retrySave":
        await this.#saving.retry(record.sessionId);
        return this.#broker.saveStatus(record.sessionId);
      case "locateSave":
        await this.#saving.locate(record.sessionId);
        return this.#broker.saveStatus(record.sessionId);
      case "scope": return this.#broker.sessionScope(record.sessionId, record.credential);
      case "exportReviewedCopy": {
        const value = payload as { readonly confirmPossiblyStale?: true };
        const frozen = await this.#broker.freezeDelivery(record.sessionId);
        return this.#exporting.exportReviewedCopy({
          ...frozen,
          ...(value.confirmPossiblyStale === true ? { staleConfirmed: true as const } : {}),
        });
      }
      default: throw new Error("chrome-method-forbidden");
    }
  }

  async readDocument(canonicalKey: string, generation: number, offset: number, length: number): Promise<Buffer> {
    const record = this.#record(canonicalKey);
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
    if (record?.created === true && !this.#activated.has(canonicalKey) && provisionalCount === 0 &&
      (this.#presentations.get(canonicalKey)?.size ?? 0) === 0) {
      await this.#broker.discard(record.sessionId).catch(() => undefined);
      this.#records.delete(canonicalKey);
      this.#index.delete(canonicalKey);
    }
  }

  #record(canonicalKey: string): CanonicalRecord {
    const record = this.#records.get(canonicalKey);
    if (record === undefined) throw new Error("canonical-review-unavailable");
    return record;
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
        const opened = await this.#broker.openReview({ pdfPath: canonicalPath, surface: "chrome" });
        if (opened.kind === "recovery-offered") throw new Error("recovery-required");
        const record = await this.#recordFromLaunch(opened.launch, false);
        const canonicalKey = `${request.sourceIdentity}:${record.sha256}:${record.generation}`;
        this.#records.set(canonicalKey, { ...record, canonicalKey });
        this.#provisionals.set(canonicalKey, (this.#provisionals.get(canonicalKey) ?? 0) + 1);
        try {
          return {
            canonicalKey,
            projection: await this.#projection({ ...record, canonicalKey }),
          };
        } catch (error) {
          await this.release(canonicalKey);
          throw error;
        }
      },
      cancel: async () => undefined,
    };
  }

  async #openRemote(
    handle: SealedBrowserSourceHandle,
    sourceIdentity: string,
    source: { readonly sha256: string; readonly byteLength: number; readonly displayName?: string },
  ): Promise<CanonicalRecord> {
    const opened = await this.#broker.openChromeBrowserSource({
      protocolVersion: CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION,
      sourceHandle: handle,
      sourceIdentity,
      byteLength: source.byteLength,
      sha256: source.sha256,
      ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    }, this.#browserSources);
    if (opened.kind === "recovery-offered") throw new Error("recovery-required");
    return this.#recordFromLaunch(opened.launch, opened.kind === "opened");
  }

  async #recordFromLaunch(launch: SessionLaunch, created: boolean): Promise<CanonicalRecord> {
    const capability = new URLSearchParams(launch.fragment.slice(1)).get("cap");
    const credential = capability === null ? undefined : this.#broker.exchangeBootstrap(launch.sessionId, capability);
    const state = this.#broker.state(launch.sessionId);
    if (credential === undefined || state === undefined) throw new Error("bootstrap-unavailable");
    return {
      canonicalKey: "pending", sessionId: launch.sessionId, credential,
      generation: state.workflow.documentGeneration, sha256: state.source.digest,
      byteLength: state.source.byteLength, created,
    };
  }

  async #projection(record: CanonicalRecord): Promise<ChromeRuntimeProjection> {
    const state = this.#broker.state(record.sessionId);
    const scope = await this.#broker.sessionScope(record.sessionId, record.credential);
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
      location: { kind: "page", page: 1 },
      document: { sha256: state.source.digest, byteLength: state.source.byteLength, generation: state.workflow.documentGeneration },
    };
  }
}
