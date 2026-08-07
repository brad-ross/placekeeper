import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  documentOrderedItems,
  projectReviewItems,
} from "../../../../packages/core/src/annotation-projection.js";
import type {
  ReviewCommand,
  ReviewState,
} from "../../../../packages/core/src/review-model.js";
import { createReviewState } from "../../../../packages/core/src/review-model.js";
import { reduceReview } from "../../../../packages/core/src/review-reducer.js";
import { SessionCredentialStore } from "../../../../packages/core/src/session-security.js";
import {
  FileCapabilityRegistry,
  hashFile,
} from "../files/file-capabilities.js";
import {
  DraftSnapshotStore,
  type RecoverableDraft,
  type SnapshotHooks,
} from "../recovery/draft-snapshot.js";
import {
  createSourceSnapshot,
  ensurePrivateDirectory,
} from "../recovery/source-snapshot.js";
import type { FrozenReviewDelivery } from "../export/export-coordinator.js";
import { SessionControlRegistry } from "./control-socket.js";

export type RecoveryDecision = "resume" | "discard" | "fork";

export interface OpenReviewRequest {
  readonly pdfPath: string;
  readonly sourceRootPath?: string;
  readonly recoveryDecision?: RecoveryDecision;
}

export interface SessionLaunch {
  readonly sessionId: string;
  readonly fileId: string;
  readonly rootId?: string;
  readonly launchPath: string;
  readonly fragment: string;
}

export type OpenReviewResult =
  | { readonly kind: "opened" | "focused"; readonly launch: SessionLaunch }
  | {
      readonly kind: "recovery-offered";
      readonly recoverySessionId: string;
      readonly choices: readonly RecoveryDecision[];
    };

interface ActiveSession {
  readonly id: string;
  readonly canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
  readonly store: DraftSnapshotStore;
  readonly fileId: string;
  readonly rootId?: string;
  state: ReviewState;
  lastExportAt?: string;
  currentOriginalDigest: string;
  acceptedOriginalDigests: string[];
  ending: boolean;
  writeTail: Promise<void>;
}

export interface SessionBrokerOptions {
  readonly recoveryRoot: string;
  readonly capabilities?: FileCapabilityRegistry;
  readonly credentials?: SessionCredentialStore;
  readonly controls?: SessionControlRegistry;
  readonly now?: () => Date;
  readonly snapshotHooks?: SnapshotHooks;
}

function activeKey(path: string, digest: string): string {
  return `${path}\0${digest}`;
}

export class SessionBroker {
  readonly recoveryRoot: string;
  readonly capabilities: FileCapabilityRegistry;
  readonly credentials: SessionCredentialStore;
  readonly controls: SessionControlRegistry;
  readonly #now: () => Date;
  readonly #snapshotHooks: SnapshotHooks;
  readonly #activeById = new Map<string, ActiveSession>();
  readonly #activeBySource = new Map<string, string>();

  constructor(options: SessionBrokerOptions) {
    this.recoveryRoot = options.recoveryRoot;
    this.capabilities = options.capabilities ?? new FileCapabilityRegistry();
    this.credentials = options.credentials ?? new SessionCredentialStore();
    this.controls = options.controls ?? new SessionControlRegistry();
    this.#now = options.now ?? (() => new Date());
    this.#snapshotHooks = options.snapshotHooks ?? {};
  }

  #store(sessionId: string): DraftSnapshotStore {
    return new DraftSnapshotStore(
      join(this.recoveryRoot, sessionId),
      this.#snapshotHooks,
    );
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.recoveryRoot);
    const entries = await readdir(this.recoveryRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.#store(entry.name).initialize(),
        ),
    );
  }

  async #recoverableDrafts(): Promise<RecoverableDraft[]> {
    await this.initialize();
    const entries = await readdir(this.recoveryRoot, { withFileTypes: true });
    const recovered = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.#store(entry.name).recover(),
        ),
    );
    return recovered.filter(
      (draft): draft is RecoverableDraft => draft !== undefined,
    );
  }

  #launch(session: ActiveSession): SessionLaunch {
    const capability = this.credentials.issueBootstrap(session.id);
    return {
      sessionId: session.id,
      fileId: session.fileId,
      ...(session.rootId === undefined ? {} : { rootId: session.rootId }),
      launchPath: `/s/${session.id}/bootstrap`,
      fragment: `#cap=${capability}`,
    };
  }

  async openReview(request: OpenReviewRequest): Promise<OpenReviewResult> {
    await this.initialize();
    const approvedFile = await this.capabilities.approvePdf(request.pdfPath);
    const sourceDigest = await hashFile(approvedFile.canonicalPath);
    const key = activeKey(approvedFile.canonicalPath, sourceDigest);
    const existingSessionId = this.#activeBySource.get(key);
    if (existingSessionId !== undefined && request.recoveryDecision !== "fork") {
      this.capabilities.revokeFile(approvedFile.id);
      const session = this.#activeById.get(existingSessionId);
      if (session === undefined) throw new Error("Active session index is inconsistent");
      return { kind: "focused", launch: this.#launch(session) };
    }

    const drafts = await this.#recoverableDrafts();
    const matchingDraft = drafts.find(
      (draft) =>
        draft.canonicalSourcePath === approvedFile.canonicalPath &&
        (draft.state.source.digest === sourceDigest ||
          draft.acceptedOriginalDigests?.includes(sourceDigest) === true),
    );

    if (matchingDraft !== undefined && request.recoveryDecision === undefined) {
      this.capabilities.revokeFile(approvedFile.id);
      return {
        kind: "recovery-offered",
        recoverySessionId: matchingDraft.state.sessionId,
        choices: ["resume", "discard", "fork"],
      };
    }

    if (matchingDraft !== undefined && request.recoveryDecision === "discard") {
      await this.#store(matchingDraft.state.sessionId).remove();
    }

    let approvedRoot:
      | { readonly id: string; readonly canonicalPath: string }
      | undefined;
    if (request.sourceRootPath !== undefined) {
      approvedRoot = await this.capabilities.approveRoot(request.sourceRootPath);
    }

    if (matchingDraft !== undefined && request.recoveryDecision === "resume") {
      if (
        (await hashFile(matchingDraft.sourceSnapshotPath)) !==
          matchingDraft.state.source.digest ||
        (await readFile(matchingDraft.sourceSnapshotPath)).byteLength !==
          matchingDraft.state.source.byteLength
      ) {
        throw new Error("Recovery source snapshot failed integrity validation");
      }
      const resumedState: ReviewState = {
        ...matchingDraft.state,
        source: { ...matchingDraft.state.source, fileId: approvedFile.id },
        ...(approvedRoot === undefined ? {} : { sourceRootId: approvedRoot.id }),
      };
      if (approvedRoot === undefined) delete (resumedState as { sourceRootId?: string }).sourceRootId;
      const session: ActiveSession = {
        id: matchingDraft.state.sessionId,
        canonicalSourcePath: approvedFile.canonicalPath,
        sourceSnapshotPath: matchingDraft.sourceSnapshotPath,
        store: this.#store(matchingDraft.state.sessionId),
        fileId: approvedFile.id,
        ...(approvedRoot === undefined ? {} : { rootId: approvedRoot.id }),
        state: resumedState,
        ...(matchingDraft.lastExportAt === undefined
          ? {}
          : { lastExportAt: matchingDraft.lastExportAt }),
        currentOriginalDigest: sourceDigest,
        acceptedOriginalDigests: [...(matchingDraft.acceptedOriginalDigests ?? [])],
        writeTail: Promise.resolve(),
        ending: false,
      };
      this.#activate(session);
      return { kind: "opened", launch: this.#launch(session) };
    }

    const sessionId = randomUUID();
    const sessionDirectory = join(this.recoveryRoot, sessionId);
    const sourceSnapshot = await createSourceSnapshot(
      approvedFile.canonicalPath,
      sessionDirectory,
    );
    const state = createReviewState({
      sessionId,
      source: {
        fileId: approvedFile.id,
        digest: sourceSnapshot.digest,
        byteLength: sourceSnapshot.byteLength,
      },
      ...(approvedRoot === undefined ? {} : { sourceRootId: approvedRoot.id }),
    });
    const session: ActiveSession = {
      id: sessionId,
      canonicalSourcePath: approvedFile.canonicalPath,
      sourceSnapshotPath: sourceSnapshot.path,
      store: this.#store(sessionId),
      fileId: approvedFile.id,
      ...(approvedRoot === undefined ? {} : { rootId: approvedRoot.id }),
      state,
      currentOriginalDigest: sourceSnapshot.digest,
      acceptedOriginalDigests: [],
      ending: false,
      writeTail: Promise.resolve(),
    };
    await session.store.persist(this.#draft(session));
    this.#activate(session);
    return { kind: "opened", launch: this.#launch(session) };
  }

  #activate(session: ActiveSession): void {
    this.#activeById.set(session.id, session);
    this.#activeBySource.set(
      activeKey(session.canonicalSourcePath, session.state.source.digest),
      session.id,
    );
    this.#activeBySource.set(
      activeKey(session.canonicalSourcePath, session.currentOriginalDigest),
      session.id,
    );
  }

  #draft(session: ActiveSession): RecoverableDraft {
    return {
      schemaVersion: 1,
      canonicalSourcePath: session.canonicalSourcePath,
      sourceSnapshotPath: session.sourceSnapshotPath,
      state: session.state,
      acknowledgedAt: this.#now().toISOString(),
      ...(session.lastExportAt === undefined
        ? {}
        : { lastExportAt: session.lastExportAt }),
      ...(session.acceptedOriginalDigests.length === 0
        ? {}
        : { acceptedOriginalDigests: [...session.acceptedOriginalDigests] }),
    };
  }

  exchangeBootstrap(sessionId: string, capability: string): string | undefined {
    if (!this.#activeById.has(sessionId)) return undefined;
    return this.credentials.exchangeBootstrap(sessionId, capability);
  }

  authenticate(sessionId: string, credential: string): boolean {
    return (
      this.#activeById.has(sessionId) &&
      this.credentials.authenticate(sessionId, credential)
    );
  }

  state(sessionId: string): ReviewState | undefined {
    return this.#activeById.get(sessionId)?.state;
  }

  sessionScope(sessionId: string):
    | { readonly documentTitle: string; readonly sourceRootPath?: string }
    | undefined {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return undefined;
    const sourceRootPath = session.rootId === undefined
      ? undefined
      : this.capabilities.getRootPath(session.rootId);
    return {
      documentTitle: basename(session.canonicalSourcePath),
      ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
    };
  }

  async documentBytes(sessionId: string): Promise<Buffer | undefined> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return undefined;
    return readFile(session.sourceSnapshotPath);
  }

  async freezeDelivery(sessionId: string): Promise<FrozenReviewDelivery> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    try {
      if (session.ending) throw new Error("Review session is ending");
      const state = structuredClone(session.state);
      const sourceRootPath = session.rootId === undefined
        ? undefined
        : this.capabilities.getRootPath(session.rootId);
      return {
        sessionId: session.id,
        source: { ...state.source },
        originalDigest: session.currentOriginalDigest,
        revision: state.revision,
        sourceSnapshotPath: session.sourceSnapshotPath,
        annotations: projectReviewItems(state.items),
        items: documentOrderedItems(state.items),
        ...(session.rootId === undefined ? {} : { sourceRootId: session.rootId }),
        ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
      };
    } finally {
      release();
    }
  }

  async acceptMutation(
    sessionId: string,
    command: ReviewCommand,
  ): Promise<ReviewState> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }

    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      write.signal.throwIfAborted();
      const nextState = reduceReview(session.state, command);
      const nextDraft: RecoverableDraft = {
        ...this.#draft(session),
        state: nextState,
        acknowledgedAt: this.#now().toISOString(),
      };
      await session.store.persist(nextDraft, write.signal);
      write.signal.throwIfAborted();
      session.state = nextState;
      return nextState;
    } finally {
      write.complete();
      release();
    }
  }

  async recordSuccessfulExport(sessionId: string): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const lastExportAt = this.#now().toISOString();
      await session.store.persist(
        { ...this.#draft(session), lastExportAt },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.lastExportAt = lastExportAt;
    } finally {
      write.complete();
      release();
    }
  }

  async recordSuccessfulReplacement(
    sessionId: string,
    replacementDigest: string,
  ): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const lastExportAt = this.#now().toISOString();
      const acceptedOriginalDigests = [
        ...new Set([...session.acceptedOriginalDigests, replacementDigest]),
      ];
      await session.store.persist(
        {
          ...this.#draft(session),
          lastExportAt,
          acceptedOriginalDigests,
        },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.lastExportAt = lastExportAt;
      session.currentOriginalDigest = replacementDigest;
      session.acceptedOriginalDigests = acceptedOriginalDigests;
      this.#activeBySource.set(
        activeKey(session.canonicalSourcePath, replacementDigest),
        session.id,
      );
    } finally {
      write.complete();
      release();
    }
  }

  async prepareReplacement(
    sessionId: string,
    candidateDigest: string,
  ): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const acceptedOriginalDigests = [
        ...new Set([...session.acceptedOriginalDigests, candidateDigest]),
      ];
      await session.store.persist(
        { ...this.#draft(session), acceptedOriginalDigests },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.acceptedOriginalDigests = acceptedOriginalDigests;
    } finally {
      write.complete();
      release();
    }
  }

  async finish(sessionId: string): Promise<void> {
    await this.#end(sessionId);
  }

  async discard(sessionId: string): Promise<void> {
    await this.#end(sessionId);
  }

  async #end(sessionId: string): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return;
    session.ending = true;
    this.#activeById.delete(sessionId);
    for (const [key, owner] of this.#activeBySource) {
      if (owner === sessionId) this.#activeBySource.delete(key);
    }
    for (const candidate of this.#activeById.values()) {
      if (!candidate.ending && candidate.canonicalSourcePath === session.canonicalSourcePath) {
        this.#activeBySource.set(
          activeKey(candidate.canonicalSourcePath, candidate.currentOriginalDigest),
          candidate.id,
        );
      }
    }
    this.controls.cancel(sessionId);
    await session.writeTail;
    this.credentials.revokeSession(sessionId);
    this.capabilities.revokeFile(session.fileId);
    if (session.rootId !== undefined) this.capabilities.revokeRoot(session.rootId);
    await session.store.remove();
  }
}
