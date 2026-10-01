import { randomBytes } from "node:crypto";
import {
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
import type { SessionBroker } from "../sessions/session-broker.js";

const secret = (): string => randomBytes(32).toString("base64url");
const opaque = (): string => randomBytes(16).toString("base64url");

type Scope = NonNullable<ReturnType<SessionBroker["nativeAdmissionScope"]>>;

interface Launch {
  readonly scope: Scope;
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
  } = {}) {
    this.#broker = broker;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.pendingTtlMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs <= 0
    ) {
      throw new RangeError("Invalid pending TTL");
    }
    this.#unsubscribeState = broker.onStateInvalidation((event) => {
      for (const [id, panel] of this.#panels) {
        if (panel.launch.scope.reviewSessionId !== event.sessionId) continue;
        panel.watermark += 1;
        if (event.reason === "generation" && panel.meta.generation !== event.documentGeneration) {
          this.#removePanel(id);
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
      this.#disposed ||
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
    return active;
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
        (panel.active === undefined ? panel.launch.expiresAtMs <= now : !this.#authorized(panel))
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
