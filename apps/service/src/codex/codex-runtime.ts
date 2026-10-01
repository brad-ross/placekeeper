import { randomBytes } from "node:crypto";
import {
  CODEX_MAX_ENCODED_RESPONSE_BYTES,
  parseCodexAppRequest,
  parseCodexDisplayReceipt,
  type CodexAppRequest,
  type CodexAppResponse,
  type CodexDisplayReceipt,
  type CodexNativeLaunchSuccess,
  type CodexPendingPresentation,
} from "../../../../packages/core/src/codex-mcp-protocol.js";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";
import type { MatchedRestartReconnectTicket } from "../context/restart-reconnect-store.js";
import type { TaskBindingAuthorityCheck } from "../context/task-binding-registry.js";
import { CodexServiceRuntimeBackend } from "./codex-runtime-backend.js";
import type { SessionBroker } from "../sessions/session-broker.js";

const secret = (): string => randomBytes(32).toString("base64url");
const opaque = (): string => randomBytes(16).toString("base64url");

type Scope = NonNullable<ReturnType<SessionBroker["nativeAdmissionScope"]>>;

interface Launch {
  scope: Scope;
  readonly handoff: string;
  readonly bindProof: string;
  readonly admissionKey: string;
  readonly expiresAtMs: number;
  owner?: string;
}

interface Panel {
  readonly launch: Launch;
  readonly meta: CodexPendingPresentation;
  watermark: number;
  leaseExpiresAtMs?: number;
  relocatedTicket?: Promise<void>;
  ready: boolean;
  attested: boolean;
  active?: Extract<CodexAppResponse, { status: "active" }>;
  restart?: MatchedRestartReconnectTicket;
}

const denied = (reason: Extract<CodexAppResponse, { status: "denied" }>["reason"]): CodexAppResponse => ({
  status: "denied",
  reason,
});

/** Service authority only. Call claimLaunch/attestDisplay/trustedTaskPrompt exclusively
 * from parsed trusted hooks. Model arguments and transport identities cannot supply owners. */
export class CodexRuntimeManager {
  readonly #broker: SessionBroker;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #panelLeaseMs: number;
  readonly #backend: CodexServiceRuntimeBackend | undefined;
  readonly #leaseTimer: ReturnType<typeof setInterval>;
  readonly #requests = new Set<Promise<CodexAppResponse>>();
  #closing = false;
  readonly #launches = new Map<string, Launch>();
  readonly #panels = new Map<string, Panel>();
  // A restart ticket cannot revive a detached/expired panel in its issuing process.
  readonly #seenRuntimes = new Map<string, number>();
  readonly #prompts = new Map<string, {
    task: string;
    expiresAtMs: number;
  }>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeState: () => void;
  #disposed = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(broker: SessionBroker, options: {
    readonly now?: () => Date;
    readonly pendingTtlMs?: number;
    readonly panelLeaseMs?: number;
    readonly backend?: CodexServiceRuntimeBackend;
  } = {}) {
    this.#broker = broker;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.pendingTtlMs ?? 60_000;
    this.#panelLeaseMs = options.panelLeaseMs ?? 30_000;
    this.#backend = options.backend;
    if (!Number.isSafeInteger(this.#panelLeaseMs) || this.#panelLeaseMs <= 0) throw new RangeError("Invalid panel lease");
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs <= 0
    ) {
      throw new RangeError("Invalid pending TTL");
    }
    this.#leaseTimer = setInterval(() => this.#sweep(), Math.min(1000, this.#panelLeaseMs));
    this.#leaseTimer.unref();
    this.#unsubscribeState = broker.onStateInvalidation((event) => {
      for (const [id, panel] of this.#panels) {
        if (panel.launch.scope.reviewSessionId !== event.sessionId) continue;
        panel.watermark += 1;
        // Only the broker's committed save notification can migrate a path.
        // Relocation preserves this exact review, generation and PDF digest.
        const relocated = event.reason === "save" ? broker.nativeAdmissionScope(event.sessionId) : undefined;
        if (relocated !== undefined && relocated.documentGeneration === panel.meta.generation &&
          relocated.sourceDigest === panel.launch.scope.sourceDigest &&
          relocated.canonicalSourcePath !== panel.launch.scope.canonicalSourcePath) {
          panel.launch.scope = relocated;
          if (panel.active !== undefined) {
            const refreshing = this.#serialize(() => this.#refreshRelocatedTicket(panel));
            panel.relocatedTicket = refreshing.catch(() => { this.#removePanel(id); });
          }
        }
        if (event.reason === "generation" && panel.meta.generation !== event.documentGeneration) {
          this.#removePanel(id);
        }
      }
      if (event.reason === "save") {
        const relocated = broker.nativeAdmissionScope(event.sessionId);
        for (const launch of this.#launches.values()) {
          if (relocated !== undefined && launch.scope.reviewSessionId === event.sessionId &&
            launch.scope.documentGeneration === relocated.documentGeneration && launch.scope.sourceDigest === relocated.sourceDigest) {
            launch.scope = relocated;
          }
        }
      }
      if (event.reason === "generation") {
        for (const [key, launch] of this.#launches) {
          if (launch.scope.reviewSessionId === event.sessionId && launch.scope.documentGeneration !== event.documentGeneration) {
            this.#broker.taskBindings.detachPresentation(digestSecretHex(launch.admissionKey));
            this.#launches.delete(key);
          }
        }
      }
    });
    this.#unsubscribe = broker.onSessionEnd((sessionId) => {
      for (const [id, panel] of this.#panels) {
        if (panel.launch.scope.reviewSessionId === sessionId) {
          this.#removePanel(id);
        }
      }
      for (const [key, launch] of this.#launches) {
        if (launch.scope.reviewSessionId === sessionId) {
          this.#launches.delete(key);
        }
      }
    });
  }

  stageLaunch(input: {
    readonly sessionId: string;
    readonly kind: "opened" | "focused";
  }): CodexNativeLaunchSuccess | undefined {
    this.#sweep();
    const scope = this.#broker.nativeAdmissionScope(input.sessionId);
    if (
      this.#disposed || this.#closing ||
      scope === undefined
    ) {
      return undefined;
    }
    const admissionKey = secret();
    const handoff = secret();
    const bindProof = this.#broker.taskBindings.issueBindProof({
      ...scope,
      browserCapability: admissionKey,
      native: true,
    });
    const expiresAtMs = this.#now().getTime() + this.#ttlMs;
    this.#launches.set(digestSecretHex(handoff), {
      scope,
      handoff,
      bindProof,
      admissionKey,
      expiresAtMs,
    });
    return {
      ok: true,
      kind: input.kind,
      surface: "codex-native",
      sessionId: scope.reviewSessionId,
      documentGeneration: scope.documentGeneration,
      bindProof,
      handoff: {
        token: handoff,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  claimLaunch(input: {
    readonly bindProof: string;
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): boolean {
    if (this.#closing) return false;
    this.#sweep();
    const launch = [...this.#launches.values()].find((entry) => entry.bindProof === input.bindProof);
    if (
      launch === undefined ||
      launch.owner !== undefined ||
      !this.#current(launch)
    ) {
      return false;
    }
    const result = this.#broker.taskBindings.claimNative(input);
    if (result.status === "denied") {
      return false;
    }
    launch.owner = input.taskSessionId;
    return true;
  }

  display(handoff: string): {
    readonly receipt: CodexDisplayReceipt;
    readonly privateMeta: CodexPendingPresentation;
  } | undefined {
    if (this.#closing) return undefined;
    this.#sweep();
    const key = digestSecretHex(handoff);
    const launch = this.#launches.get(key);
    if (
      launch === undefined ||
      launch.owner === undefined ||
      !this.#current(launch) ||
      !this.#broker.taskBindings.nativeClaimMatches({
        ...launch.scope,
        taskSessionId: launch.owner,
        browserCapabilityHash: digestSecretHex(launch.admissionKey),
      })
    ) {
      return undefined;
    }
    this.#launches.delete(key);
    const meta: CodexPendingPresentation = {
      protocolVersion: 1,
      runtimeId: opaque(),
      attemptId: opaque(),
      generation: launch.scope.documentGeneration,
      receiptId: opaque(),
      pendingCapability: secret(),
    };
    this.#seenRuntimes.set(meta.runtimeId, this.#now().getTime() + this.#broker.restartReconnects.ticketLifetimeMs);
    this.#panels.set(meta.runtimeId, {
      launch,
      meta,
      watermark: 0,
      ready: false,
      attested: false,
    });
    return {
      receipt: {
        protocolVersion: 1,
        status: "pending",
        receiptId: meta.receiptId,
        attemptId: meta.attemptId,
        generation: meta.generation,
      },
      privateMeta: meta,
    };
  }

  attestDisplay(rawReceipt: unknown, trustedTaskSessionId: string): boolean {
    if (this.#closing) return false;
    this.#sweep();
    const receipt = parseCodexDisplayReceipt(rawReceipt);
    const panel = receipt === undefined ? undefined : [...this.#panels.values()].find((entry) => entry.meta.receiptId === receipt.receiptId);
    if (
      panel === undefined ||
      panel.restart !== undefined ||
      panel.attested ||
      receipt?.attemptId !== panel.meta.attemptId ||
      receipt.generation !== panel.meta.generation ||
      panel.launch.owner !== trustedTaskSessionId ||
      !this.#claimed(panel)
    ) {
      return false;
    }
    panel.attested = true;
    // This hook acknowledgment never returns app authority. The authenticated pending channel promotes.
    return true;
  }

  pending(raw: unknown): Promise<CodexAppResponse> {
    if (this.#closing) return Promise.resolve(denied("unavailable"));
    return this.#serialize(async () => {
      this.#sweep();
      const request = parseCodexAppRequest(raw);
      if (request?.authority !== "pending") {
        return denied("invalid");
      }
      const panel = this.#panels.get(request.runtimeId);
      if (
        panel === undefined ||
        !this.#envelope(panel, request, panel.meta.pendingCapability)
      ) {
        return denied("invalid");
      }
      if (!this.#current(panel.launch)) {
        this.#removePanel(request.runtimeId);
        return denied("stale-generation");
      }
      if (panel.active !== undefined) {
        return this.#authorized(panel) ? panel.active : denied("revoked");
      }
      if (request.method === "ready") {
        panel.ready = true;
      }
      if (panel.restart !== undefined) {
        return this.#promoteRestart(panel);
      }
      if (!this.#claimed(panel)) {
        return denied("revoked");
      }
      if (
        !panel.ready ||
        !panel.attested
      ) {
        return {
          status: "pending",
        };
      }
      const check = this.#broker.taskBindings.beginAuthorityCheck(this.#binding(panel));
      try {
        const attached = this.#broker.taskBindings.activateNative(this.#binding(panel));
        if (attached.status !== "active") {
          return denied("revoked");
        }
        return await this.#activate(panel, check);
      } finally {
        check.release();
      }
    });
  }

  resolveActive(raw: unknown): {
    readonly sessionId: string;
    readonly taskSessionId: string;
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly generation: number;
  } | undefined {
    this.#sweep();
    const request = parseCodexAppRequest(raw);
    if (request?.authority !== "presentation") {
      return undefined;
    }
    const panel = this.#panels.get(request.runtimeId);
    if (
      panel?.active === undefined ||
      !this.#envelope(panel, request, panel.active.presentationCapability) ||
      !this.#authorized(panel)
    ) {
      return undefined;
    }
    return {
      sessionId: panel.launch.scope.reviewSessionId,
      taskSessionId: panel.launch.owner!,
      runtimeId: request.runtimeId,
      attemptId: request.attemptId,
      generation: request.generation,
    };
  }

  /** The private per-panel channel is the only entry for app operations.
   * Polling and ordinary reads never renew liveness. U3 must qualify delivery
   * of renew independently of visibility throttling. */
  handle(raw: unknown): Promise<CodexAppResponse> {
    if (this.#closing || this.#disposed) return Promise.resolve(denied("unavailable"));
    const result = this.#handle(raw).catch(() => denied("unavailable"));
    this.#requests.add(result);
    void result.then(() => this.#requests.delete(result));
    return result;
  }

  async #handle(raw: unknown): Promise<CodexAppResponse> {
    const request = parseCodexAppRequest(raw);
    if (request === undefined) return denied("invalid");
    if (request.authority === "pending") return this.pending(request);
    if (request.authority === "reconnect") return this.stageReconnect(request);
    const scope = this.resolveActive(request);
    if (scope === undefined) return denied("revoked");
    if (request.method === "detach") {
      await this.detach(scope.runtimeId);
      return { status: "ok", payload: {} };
    }
    if (request.method === "renew") {
      const panel = this.#panels.get(scope.runtimeId)!;
      const renewed = this.#broker.taskBindings.renew(this.#binding(panel));
      if (renewed.status !== "active") return denied("revoked");
      panel.leaseExpiresAtMs = this.#now().getTime() + this.#panelLeaseMs;
      return { status: "ok", payload: { leaseExpiresAt: new Date(panel.leaseExpiresAtMs).toISOString() } };
    }
    if (request.method === "watermark") {
      const watermark = this.readWatermark(request);
      return watermark === undefined ? denied("revoked") : { status: "ok", payload: watermark };
    }
    if (this.#backend === undefined) return denied("unavailable");
    try {
      const payload = await this.#backend.handle(scope, request, () => this.resolveActive(request) !== undefined);
      await this.#panels.get(scope.runtimeId)?.relocatedTicket;
      // A reply issued after detach, replacement or revocation may never
      // hydrate the old view, even if its admitted durable edit succeeded.
      if (this.resolveActive(request) === undefined) return denied("revoked");
      const response: CodexAppResponse = { status: "ok", payload };
      return Buffer.byteLength(JSON.stringify(response)) <= CODEX_MAX_ENCODED_RESPONSE_BYTES ? response : denied("unavailable");
    } catch (error) {
      return denied(error instanceof Error && error.message === "invalid-resource" ? "invalid" : "unavailable");
    }
  }

  /** Only call for a verified panel-channel EOF; a shared transport client's
   * EOF conveys no individual presentation authority and must not use this. */
  disconnect(raw: unknown): Promise<CodexAppResponse> {
    const request = parseCodexAppRequest(raw);
    if (request?.authority !== "presentation") return Promise.resolve(denied("invalid"));
    return this.handle({ ...request, method: "detach", payload: {} });
  }

  get panelLeaseMs(): number { return this.#panelLeaseMs; }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#tail;
    await Promise.allSettled([...this.#requests]);
    this.dispose();
  }

  /** Cheap app-only poll. The private active envelope authenticates scope before any read. */
  readWatermark(raw: unknown): {
    readonly watermark: number;
    readonly documentGeneration: number;
    readonly reviewRevision: number;
  } | undefined {
    const scope = this.resolveActive(raw);
    if (scope === undefined) return undefined;
    const panel = this.#panels.get(scope.runtimeId);
    const state = this.#broker.state(scope.sessionId);
    if (panel === undefined || state === undefined) return undefined;
    return {
      watermark: panel.watermark,
      documentGeneration: state.workflow.documentGeneration,
      reviewRevision: state.revision,
    };
  }

  /** The source must already have been reopened/recovered through normal approval. */
  stageReconnect(raw: unknown): Promise<CodexAppResponse> {
    if (this.#closing) return Promise.resolve(denied("unavailable"));
    return this.#serialize(async () => {
      this.#sweep();
      const request = parseCodexAppRequest(raw);
      if (
        request?.authority !== "reconnect" ||
        this.#disposed
      ) {
        return denied("invalid");
      }
      if (this.#seenRuntimes.has(request.runtimeId)) {
        return denied("replayed");
      }
      const ticket = await this.#broker.restartReconnects.matchNative({
        ticket: request.capability,
        runtimeId: request.runtimeId,
        attemptId: request.attemptId,
        documentGeneration: request.generation,
      });
      if (
        ticket === undefined ||
        this.#disposed
      ) {
        return denied("revoked");
      }
      const scope = this.#broker.nativeRestartScope(ticket.sourcePathHash, ticket.sourceDigest, ticket.reviewSessionHash);
      if (scope === undefined) {
        return denied("unavailable");
      }
      if (scope.documentGeneration !== request.generation) {
        return denied("stale-generation");
      }
      const meta: CodexPendingPresentation = {
        protocolVersion: 1,
        runtimeId: request.runtimeId,
        attemptId: request.attemptId,
        generation: request.generation,
        receiptId: opaque(),
        pendingCapability: request.capability,
      };
      const panel: Panel = {
        launch: {
          scope,
          handoff: "",
          bindProof: "",
          admissionKey: secret(),
          expiresAtMs: Math.min(ticket.expiresAtMs, this.#now().getTime() + this.#ttlMs),
        },
        meta,
        watermark: 0,
        ready: true,
        attested: false,
        restart: ticket,
      };
      this.#seenRuntimes.set(request.runtimeId, ticket.expiresAtMs);
      this.#panels.set(request.runtimeId, panel);
      return this.#promoteRestart(panel);
    });
  }

  trustedTaskPrompt(taskSessionId: string): Promise<void> {
    if (this.#closing) return Promise.resolve();
    return this.#serialize(async () => {
      this.#sweep();
      if (
        this.#disposed ||
        taskSessionId.length === 0 ||
        taskSessionId.length > 512
      ) {
        return;
      }
      this.#prompts.set(digestSecretHex(taskSessionId), {
        task: taskSessionId,
        expiresAtMs: this.#now().getTime() + this.#ttlMs,
      });
      for (const panel of this.#panels.values()) {
        if (
          panel.restart !== undefined &&
          panel.active === undefined
        ) {
          await this.#promoteRestart(panel);
        }
      }
    });
  }

  async #promoteRestart(panel: Panel): Promise<CodexAppResponse> {
    const ticket = panel.restart!;
    const prompt = this.#prompts.get(ticket.taskSessionHash);
    if (prompt === undefined) {
      return {
        status: "pending",
      };
    }
    if (!this.#current(panel.launch)) {
      return denied("stale-generation");
    }
    const check = this.#broker.taskBindings.beginAuthorityCheck({
      taskSessionId: prompt.task,
      ...panel.launch.scope,
    });
    try {
      const consumed = await this.#broker.restartReconnects.consumeForTask(ticket, prompt.task);
      if (!consumed || !check.isCurrent() || !this.#panelCurrent(panel)) {
        return denied("revoked");
      }
      panel.launch.owner = prompt.task;
      const attached = this.#broker.taskBindings.attachReconnectedNative(this.#binding(panel));
      if (attached.status !== "active") {
        return denied("owner-mismatch");
      }
      return await this.#activate(panel, check);
    } finally {
      check.release();
    }
  }

  async #activate(panel: Panel, check: TaskBindingAuthorityCheck): Promise<CodexAppResponse> {
    const active: Extract<CodexAppResponse, { status: "active" }> = {
      status: "active",
      runtimeId: panel.meta.runtimeId,
      attemptId: panel.meta.attemptId,
      generation: panel.meta.generation,
      presentationCapability: secret(),
      reconnectTicket: secret(),
    };
    try {
      await this.#broker.restartReconnects.issue({
        ...panel.launch.scope,
        taskSessionId: panel.launch.owner!,
        browserToken: active.reconnectTicket,
        native: {
          runtimeId: active.runtimeId,
          attemptId: active.attemptId,
          documentGeneration: active.generation,
        },
      });
    } catch (error) {
      this.#removePanel(panel.meta.runtimeId);
      throw error;
    }
    if (
      !check.isCurrent() ||
      !this.#panelCurrent(panel) ||
      !this.#authorizedBinding(panel)
    ) {
      this.#removePanel(panel.meta.runtimeId);
      await this.#broker.restartReconnects.revokeToken(active.reconnectTicket);
      return denied("revoked");
    }
    this.#seenRuntimes.set(active.runtimeId, this.#now().getTime() + this.#broker.restartReconnects.ticketLifetimeMs);
    panel.active = active;
    panel.leaseExpiresAtMs = this.#now().getTime() + this.#panelLeaseMs;
    this.#backend?.attach({ sessionId: panel.launch.scope.reviewSessionId, taskSessionId: panel.launch.owner!,
      runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation });
    return active;
  }

  async #refreshRelocatedTicket(panel: Panel): Promise<void> {
    if (!this.#panelCurrent(panel) || !this.#authorized(panel) || panel.active === undefined) return;
    const check = this.#broker.taskBindings.beginAuthorityCheck(this.#binding(panel));
    const active = panel.active;
    try {
      await this.#broker.restartReconnects.issue({
        ...panel.launch.scope,
        taskSessionId: panel.launch.owner!,
        browserToken: active.reconnectTicket,
        native: { runtimeId: active.runtimeId, attemptId: active.attemptId, documentGeneration: active.generation },
      });
      // Disposal preserves restart continuation; canonical revocation still
      // owns persisted revocation independently through the ticket store.
      if (!this.#disposed && (!check.isCurrent() || !this.#panelCurrent(panel) || !this.#authorized(panel))) {
        await this.#broker.restartReconnects.revokeToken(active.reconnectTicket);
      }
    } finally { check.release(); }
  }

  revokeTask(taskSessionId: string): Promise<void> {
    return this.#serialize(async () => {
      this.#prompts.delete(digestSecretHex(taskSessionId));
      this.#broker.taskBindings.revokeTask(taskSessionId);
      for (const [id, panel] of this.#panels) {
        if (
          panel.launch.owner === taskSessionId ||
          panel.restart?.taskSessionHash === digestSecretHex(taskSessionId)
        ) {
          this.#removePanel(id);
        }
      }
      for (const [key, launch] of this.#launches) {
        if (launch.owner === taskSessionId) {
          this.#launches.delete(key);
        }
      }
      await this.#broker.restartReconnects.revokeTask(taskSessionId);
    });
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.#serialize(async () => {
      this.#broker.taskBindings.revokeSession(sessionId);
      for (const [id, panel] of this.#panels) {
        if (panel.launch.scope.reviewSessionId === sessionId) {
          this.#removePanel(id);
        }
      }
      for (const [key, launch] of this.#launches) {
        if (launch.scope.reviewSessionId === sessionId) {
          this.#launches.delete(key);
        }
      }
      await this.#broker.restartReconnects.revokeSession(sessionId);
    });
  }

  detach(runtimeId: string): Promise<void> {
    return this.#serialize(async () => {
      const panel = this.#panels.get(runtimeId);
      this.#removePanel(runtimeId);
      if (panel?.active !== undefined) {
        await this.#broker.restartReconnects.revokeToken(panel.active.reconnectTicket);
      }
      if (panel?.restart !== undefined) {
        await this.#broker.restartReconnects.revokeToken(panel.meta.pendingCapability);
      }
    });
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#leaseTimer);
    this.#unsubscribe();
    this.#unsubscribeState();
    for (const id of this.#panels.keys()) {
      this.#removePanel(id);
    }
    for (const launch of this.#launches.values()) {
      this.#broker.taskBindings.detachPresentation(digestSecretHex(launch.admissionKey));
    }
    this.#launches.clear();
    this.#prompts.clear();
    this.#seenRuntimes.clear();
  }

  activityCount(): number {
    this.#sweep();
    return this.#panels.size + this.#launches.size;
  }

  #binding(panel: Panel) {
    return {
      taskSessionId: panel.launch.owner!,
      ...panel.launch.scope,
      browserCapabilityHash: digestSecretHex(panel.launch.admissionKey),
    };
  }

  #claimed(panel: Panel): boolean {
    return this.#current(panel.launch) && this.#broker.taskBindings.nativeClaimMatches(this.#binding(panel));
  }

  #authorizedBinding(panel: Panel): boolean {
    return this.#broker.taskBindings.hasPresentationAuthority(this.#binding(panel));
  }

  #authorized(panel: Panel): boolean {
    return this.#current(panel.launch) && this.#authorizedBinding(panel);
  }

  #panelCurrent(panel: Panel): boolean {
    return this.#panels.get(panel.meta.runtimeId) === panel &&
      this.#current(panel.launch) &&
      (panel.active !== undefined || panel.launch.expiresAtMs > this.#now().getTime());
  }

  #current(launch: Launch): boolean {
    const live = this.#broker.nativeAdmissionScope(launch.scope.reviewSessionId);
    return !this.#disposed &&
      live?.documentGeneration === launch.scope.documentGeneration &&
      live.sourceDigest === launch.scope.sourceDigest &&
      live.canonicalSourcePath === launch.scope.canonicalSourcePath;
  }

  #envelope(panel: Panel, request: CodexAppRequest, capability: string): boolean {
    return panel.meta.attemptId === request.attemptId &&
      panel.meta.generation === request.generation &&
      digestSecretHex(capability) === digestSecretHex(request.capability);
  }

  #removePanel(id: string): void {
    const panel = this.#panels.get(id);
    if (panel !== undefined) {
      this.#broker.taskBindings.detachPresentation(digestSecretHex(panel.launch.admissionKey));
      this.#backend?.detach(id);
    }
    this.#panels.delete(id);
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [key, launch] of this.#launches) {
      if (
        launch.expiresAtMs <= now ||
        !this.#current(launch)
      ) {
        this.#broker.taskBindings.detachPresentation(digestSecretHex(launch.admissionKey));
        this.#launches.delete(key);
      }
    }
    for (const [id, panel] of this.#panels) {
      if (
        !this.#current(panel.launch) ||
        (panel.active === undefined ? panel.launch.expiresAtMs <= now :
          panel.leaseExpiresAtMs! <= now || !this.#authorized(panel))
      ) {
        this.#removePanel(id);
      }
    }
    for (const [id, expiresAt] of this.#seenRuntimes) {
      if (expiresAt <= now) {
        this.#seenRuntimes.delete(id);
      }
    }
    for (const [hash, prompt] of this.#prompts) {
      if (prompt.expiresAtMs <= now) {
        this.#prompts.delete(hash);
      }
    }
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
