import { randomBytes, randomUUID } from "node:crypto";
import {
  encodePlacekeeperLinkFragment,
  encodePlacekeeperReadableViewPathname,
} from "../../../../packages/core/src/placekeeper-link.js";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";
import type { HttpBootstrapExchange } from "./session-contracts.js";
import type {
  BrowserLaunchScope,
  BrowserViewRecord,
  PendingRestartReconnect,
  ReconnectBindingMetadata,
} from "./session-internal-types.js";

// A prompt and the replacement browser bootstrap commonly arrive together;
// keep the control request bounded while allowing their two-sided handshake.
const RESTART_RECONNECT_WAIT_MS = 4_500;

type ReconnectProofMetadata = Omit<ReconnectBindingMetadata, "taskSessionId"> & {
  readonly expiresAtMs: number;
};

/** Process-local presentation metadata only. The broker authorizes every
 * transition and owns credentials, task bindings, persistence and termination. */
export class PresentationRecords {
  readonly #bootstrapScopes = new Map<string, BrowserLaunchScope>();
  readonly #credentialScopes = new Map<string, BrowserLaunchScope>();
  readonly #viewsById = new Map<string, BrowserViewRecord>();
  readonly #reconnectByBindProofHash = new Map<string, ReconnectProofMetadata>();
  readonly #reconnectBindingsByCapabilityHash = new Map<string, ReconnectBindingMetadata>();
  readonly #pendingRestartReconnects = new Map<string, PendingRestartReconnect>();
  readonly #restartReconnectWaiters = new Map<string, Set<() => void>>();

  bootstrap(key: string): BrowserLaunchScope | undefined {
    return this.#bootstrapScopes.get(key);
  }

  recordBootstrap(key: string, scope: BrowserLaunchScope): void {
    this.#bootstrapScopes.set(key, scope);
  }

  removeBootstrap(key: string): void {
    this.#bootstrapScopes.delete(key);
  }

  credentialScope(key: string): BrowserLaunchScope | undefined {
    return this.#credentialScopes.get(key);
  }

  recordCredentialScope(key: string, scope: BrowserLaunchScope): void {
    this.#credentialScopes.set(key, scope);
  }

  removeCredentialScope(key: string): void {
    this.#credentialScopes.delete(key);
  }

  reconnectProof(key: string): ReconnectProofMetadata | undefined {
    return this.#reconnectByBindProofHash.get(key);
  }

  recordReconnectProof(key: string, metadata: ReconnectProofMetadata): void {
    this.#reconnectByBindProofHash.set(key, metadata);
  }

  removeReconnectProof(key: string): void {
    this.#reconnectByBindProofHash.delete(key);
  }

  reconnectBinding(key: string): ReconnectBindingMetadata | undefined {
    return this.#reconnectBindingsByCapabilityHash.get(key);
  }

  recordReconnectBinding(key: string, binding: ReconnectBindingMetadata): void {
    this.#reconnectBindingsByCapabilityHash.set(key, binding);
  }

  reconnectBindings(): IterableIterator<ReconnectBindingMetadata> {
    return this.#reconnectBindingsByCapabilityHash.values();
  }

  pendingReconnects(): IterableIterator<[string, PendingRestartReconnect]> {
    return this.#pendingRestartReconnects.entries();
  }

  hasPendingReconnect(key: string): boolean {
    return this.#pendingRestartReconnects.has(key);
  }

  recordPendingReconnect(key: string, pending: PendingRestartReconnect): void {
    this.#pendingRestartReconnects.set(key, pending);
  }

  createView(
    sessionId: string,
    sourcePath: string,
    credential: string,
    scope: BrowserLaunchScope,
  ): HttpBootstrapExchange {
    const id = randomUUID();
    const cookie = randomBytes(32).toString("base64url");
    const location = scope.requestedLocation ?? { kind: "page" as const, page: 1 };
    const pathname = encodePlacekeeperReadableViewPathname({
      viewId: id,
      path: sourcePath,
    });
    this.#viewsById.set(id, {
      id,
      cookieHash: digestSecretHex(cookie),
      sessionId,
      documentGeneration: scope.documentGeneration,
      credential,
      pathname,
    });
    return {
      credential,
      view: {
        id,
        cookie,
        pathname,
        locationFragment: encodePlacekeeperLinkFragment(location),
        ...(scope.reconnectBrowserToken === undefined
          ? {}
          : { reconnectCookie: scope.reconnectBrowserToken }),
      },
    };
  }

  matchingView(viewId: string, pathname: string, cookieHash?: string): BrowserViewRecord | undefined {
    const view = this.#viewsById.get(viewId);
    if (
      view === undefined ||
      view.pathname !== pathname ||
      (cookieHash !== undefined && view.cookieHash !== cookieHash)
    ) return undefined;
    return view;
  }

  removeView(viewId: string): BrowserViewRecord | undefined {
    const view = this.#viewsById.get(viewId);
    this.#viewsById.delete(viewId);
    return view;
  }

  promoteReconnect(capabilityHash: string, pending: PendingRestartReconnect): void {
    for (const [credentialHash, scope] of this.#credentialScopes) {
      if (
        scope.sessionId === pending.reviewSessionId &&
        scope.documentGeneration === pending.documentGeneration &&
        scope.browserCapabilityHash === capabilityHash
      ) {
        this.#credentialScopes.set(credentialHash, {
          ...scope,
          surface: "codex",
          reconnectBrowserToken: pending.browserToken,
        });
      }

    }

  }

  removeTaskBindings(taskSessionId: string): void {
    for (const [capabilityHash, binding] of this.#reconnectBindingsByCapabilityHash) {
      if (binding.taskSessionId === taskSessionId) this.#reconnectBindingsByCapabilityHash.delete(capabilityHash);
    }

  }

  expireBootstraps(now: number): Set<string> {
    const expiredSessions = new Set<string>();
    for (const [key, scope] of this.#bootstrapScopes) {
      if (scope.expiresAtMs <= now) {
        this.#bootstrapScopes.delete(key);
        expiredSessions.add(scope.sessionId);
      }

    }

    return expiredSessions;
  }

  hasScope(sessionId: string): boolean {
    return [...this.#bootstrapScopes.values(), ...this.#credentialScopes.values()]
      .some((scope) => scope.sessionId === sessionId);
  }

  hasView(sessionId: string): boolean {
    return [...this.#viewsById.values()].some((view) => view.sessionId === sessionId);
  }

  expireReconnects(now: number): void {
    for (const [proofHash, metadata] of this.#reconnectByBindProofHash) {
      if (metadata.expiresAtMs <= now) this.#reconnectByBindProofHash.delete(proofHash);
    }

    for (const [capabilityHash, pending] of this.#pendingRestartReconnects) {
      if (pending.ticket.expiresAtMs <= now) this.#pendingRestartReconnects.delete(capabilityHash);
    }

  }

  removeSessionBootstraps(sessionId: string): void {
    for (const [key, scope] of this.#bootstrapScopes) {
      if (scope.sessionId === sessionId) this.#bootstrapScopes.delete(key);
    }

    for (const [proofHash, metadata] of this.#reconnectByBindProofHash) {
      if (metadata.reviewSessionId === sessionId) this.#reconnectByBindProofHash.delete(proofHash);
    }

  }

  migrateGeneration(sessionId: string, successorGeneration: number): void {
    for (const scope of this.#credentialScopes.values()) {
      if (scope.sessionId === sessionId) scope.documentGeneration = successorGeneration;
    }

    for (const view of this.#viewsById.values()) {
      if (view.sessionId === sessionId) view.documentGeneration = successorGeneration;
    }

  }

  removeSessionPresentations(sessionId: string): void {
    for (const [key, scope] of this.#credentialScopes) {
      if (scope.sessionId === sessionId) this.#credentialScopes.delete(key);
    }

    for (const [viewId, view] of this.#viewsById) {
      if (view.sessionId === sessionId) this.#viewsById.delete(viewId);
    }

    for (const [capabilityHash, binding] of this.#reconnectBindingsByCapabilityHash) {
      if (binding.reviewSessionId === sessionId) this.#reconnectBindingsByCapabilityHash.delete(capabilityHash);
    }

    for (const [capabilityHash, pending] of this.#pendingRestartReconnects) {
      if (pending.reviewSessionId === sessionId) {
        this.notifyRestartReconnectExchange(capabilityHash);
        this.#pendingRestartReconnects.delete(capabilityHash);
      }

    }

  }

  clear(): void {
    this.#bootstrapScopes.clear();
    this.#credentialScopes.clear();
    this.#viewsById.clear();
    this.#reconnectByBindProofHash.clear();
    this.#reconnectBindingsByCapabilityHash.clear();
    for (const capabilityHash of this.#restartReconnectWaiters.keys()) {
      this.notifyRestartReconnectExchange(capabilityHash);
    }
    this.#pendingRestartReconnects.clear();
  }

  #isAuthenticatedRestartReconnect(capabilityHash: string, pending: PendingRestartReconnect): boolean {
    return [...this.#credentialScopes.values()].some((scope) =>
      scope.sessionId === pending.reviewSessionId &&
      scope.documentGeneration === pending.documentGeneration &&
      scope.browserCapabilityHash === capabilityHash
    );
  }

  waitForRestartReconnectExchange(
    capabilityHash: string,
    pending: PendingRestartReconnect,
  ): Promise<boolean> {
    if (this.#isAuthenticatedRestartReconnect(capabilityHash, pending)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.#restartReconnectWaiters.get(capabilityHash) ?? new Set<() => void>();
      const finish = () => {
        clearTimeout(timeout);
        waiters.delete(finish);
        if (waiters.size === 0) this.#restartReconnectWaiters.delete(capabilityHash);
        resolve(this.#isAuthenticatedRestartReconnect(capabilityHash, pending));
      };
      const timeout = setTimeout(finish, RESTART_RECONNECT_WAIT_MS);
      waiters.add(finish);
      this.#restartReconnectWaiters.set(capabilityHash, waiters);
    });
  }

  notifyRestartReconnectExchange(capabilityHash: string): void {
    for (const finish of this.#restartReconnectWaiters.get(capabilityHash) ?? []) finish();
  }

  clearPendingRestartReconnects(ticketId: string): void {
    for (const [capabilityHash, candidate] of this.#pendingRestartReconnects) {
      if (candidate.ticket.ticketId !== ticketId) continue;
      this.notifyRestartReconnectExchange(capabilityHash);
      this.#pendingRestartReconnects.delete(capabilityHash);
    }

  }
}
