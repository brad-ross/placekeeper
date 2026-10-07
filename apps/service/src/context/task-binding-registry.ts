import type { NativeQualificationObserver } from "../codex/native-qualification.js";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

import type {
  LiveContextBindingStatus,
  LiveObservationIdentity,
  NativeReconnectGuidance,
} from "../../../../packages/core/src/live-context.js";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";

const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_ACTIVE_LEASE_TTL_MS = 15 * 60_000;
const MAX_ID_LENGTH = 512;

interface BindProofRecord {
  readonly proofHash: string;
  readonly native?: boolean;
  readonly browserCapabilityHash: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly expiresAtMs: number;
}

interface PendingBinding {
  readonly taskSessionId: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly browserCapabilityHash: string;
  readonly expiresAtMs: number;
}

interface ActiveBinding {
  readonly taskSessionId: string;
  readonly reviewSessionId: string;
  documentGeneration: number;
  readonly browserCapabilityHashes: Set<string>;
  leaseExpiresAtMs: number;
  lastVerified?: LiveObservationIdentity;
}

export interface TaskBindingAuthorityCheck {
  readonly isCurrent: () => boolean;
  readonly release: () => void;
}

interface InFlightAuthorityCheck {
  readonly taskSessionId: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
}

export interface TaskBindingRegistryOptions {
  readonly qualification?: NativeQualificationObserver;
  readonly now?: () => Date;
  readonly pendingTtlMs?: number;
  readonly activeLeaseTtlMs?: number;
  readonly randomProof?: () => string;
}

export interface ActiveTaskBinding {
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly leaseExpiresAt: string;
  readonly lastVerified?: LiveObservationIdentity;
}

export interface LiveReviewIdentity {
  readonly documentGeneration: number;
  readonly reviewRevision: number;
  readonly sourceDigest: string;
  readonly stateDigest: string;
}

export type TaskBindingClaimResult =
  | { readonly status: "pending"; readonly expiresAt: string }
  | { readonly status: "active"; readonly leaseExpiresAt: string }
  | { readonly status: "denied" };

export type BrowserActivationResult =
  | { readonly status: "active"; readonly leaseExpiresAt: string }
  | { readonly status: "ignored" };

type GenerationMigrationResult =
  | { readonly status: "migrated"; readonly taskSessionId: string }
  | { readonly status: "revoked" | "unbound" };

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSecretHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/**
 * Owns only task/session correlation state. A bind proof can neither read the
 * PDF nor authenticate browser routes; it is useful solely for creating a
 * pending lease that the matching browser bootstrap must activate.
 */
export class TaskBindingRegistry {
  readonly #now: () => Date;
  readonly #qualification: NativeQualificationObserver | undefined;
  readonly #pendingTtlMs: number;
  readonly #activeLeaseTtlMs: number;
  readonly #randomProof: () => string;
  readonly #proofsByHash = new Map<string, BindProofRecord>();
  readonly #proofHashByBrowserCapabilityHash = new Map<string, string>();
  readonly #authorityChecks = new Set<InFlightAuthorityCheck>();
  readonly #nativePending = new Map<string, PendingBinding>();
  readonly #pendingByTask = new Map<string, PendingBinding>();
  readonly #pendingByReview = new Map<string, PendingBinding>();
  readonly #activeByTask = new Map<string, ActiveBinding>();
  readonly #activeByReview = new Map<string, ActiveBinding>();
  readonly #expiredTasks = new Map<string, number>();
  // Advisory, daemon-local history. Not consulted by ownership or authority checks.
  readonly #nativeReconnectHints = new Map<string, { reviewSessionId: string; pdfPath: string; expiresAtMs: number }>();

  constructor(options: TaskBindingRegistryOptions = {}) {
    this.#qualification = options.qualification;
    this.#now = options.now ?? (() => new Date());
    this.#pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.#activeLeaseTtlMs = options.activeLeaseTtlMs ?? DEFAULT_ACTIVE_LEASE_TTL_MS;
    this.#randomProof = options.randomProof ?? (() => randomBytes(32).toString("base64url"));
    if (!Number.isSafeInteger(this.#pendingTtlMs) || this.#pendingTtlMs <= 0) {
      throw new RangeError("pendingTtlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#activeLeaseTtlMs) || this.#activeLeaseTtlMs <= 0) {
      throw new RangeError("activeLeaseTtlMs must be a positive safe integer");
    }
  }

  issueBindProof(input: {
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapability: string;
    readonly native?: boolean;
  }): string {
    this.#sweep();
    if (
      !validId(input.reviewSessionId) ||
      !validGeneration(input.documentGeneration) ||
      !validId(input.browserCapability)
    ) {
      throw new TypeError("Bind proof scope is invalid");
    }
    const proof = this.#randomProof();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(proof)) {
      throw new Error("Bind proof source must return 32 random base64url bytes");
    }
    const proofHash = digestSecretHex(proof);
    const browserCapabilityHash = digestSecretHex(input.browserCapability);
    const record: BindProofRecord = {
      proofHash,
      ...(input.native === true ? { native: true } : {}),
      browserCapabilityHash,
      reviewSessionId: input.reviewSessionId,
      documentGeneration: input.documentGeneration,
      expiresAtMs: this.#nowMs() + this.#pendingTtlMs,
    };
    this.#proofsByHash.set(proofHash, record);
    this.#proofHashByBrowserCapabilityHash.set(browserCapabilityHash, proofHash);
    return proof;
  }

  claim(input: {
    readonly bindProof: string;
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): TaskBindingClaimResult {
    this.#sweep();
    if (
      !validId(input.bindProof) ||
      !validId(input.taskSessionId) ||
      !validId(input.reviewSessionId) ||
      !validGeneration(input.documentGeneration)
    ) return { status: "denied" };

    const proofHash = digestSecretHex(input.bindProof);
    this.#expiredTasks.delete(input.taskSessionId);
    const proof = this.#proofsByHash.get(proofHash);
    if (proof === undefined || proof.native === true) return { status: "denied" };
    this.#consumeProof(proof);
    if (
      proof.reviewSessionId !== input.reviewSessionId ||
      proof.documentGeneration !== input.documentGeneration ||
      proof.expiresAtMs <= this.#nowMs()
    ) return { status: "denied" };

    if (!this.#associationAvailable(input)) return { status: "denied" };
    this.#discardDifferentNativeHint(input.taskSessionId, input.reviewSessionId);
    const activeForReview = this.#activeByReview.get(input.reviewSessionId);
    const activeForTask = this.#activeByTask.get(input.taskSessionId);
    if (activeForReview !== undefined || activeForTask !== undefined) {
      if (
        activeForReview === activeForTask &&
        activeForReview?.taskSessionId === input.taskSessionId &&
        activeForReview.reviewSessionId === input.reviewSessionId &&
        activeForReview.documentGeneration === input.documentGeneration
      ) {
        activeForReview.browserCapabilityHashes.add(proof.browserCapabilityHash);
        activeForReview.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
        return { status: "active", leaseExpiresAt: iso(activeForReview.leaseExpiresAtMs) };
      }
      return { status: "denied" };
    }

    const pendingForReview = this.#pendingByReview.get(input.reviewSessionId);
    const pendingForTask = this.#pendingByTask.get(input.taskSessionId);
    if (pendingForReview !== undefined || pendingForTask !== undefined) {
      if (
        pendingForReview === pendingForTask &&
        pendingForReview?.taskSessionId === input.taskSessionId &&
        pendingForReview.reviewSessionId === input.reviewSessionId &&
        pendingForReview.documentGeneration === input.documentGeneration
      ) {
        this.#removePending(pendingForReview);
      } else {
        return { status: "denied" };
      }
    }

    const pending: PendingBinding = {
      taskSessionId: input.taskSessionId,
      reviewSessionId: input.reviewSessionId,
      documentGeneration: input.documentGeneration,
      browserCapabilityHash: proof.browserCapabilityHash,
      expiresAtMs: proof.expiresAtMs,
    };
    this.#pendingByTask.set(input.taskSessionId, pending);
    this.#pendingByReview.set(input.reviewSessionId, pending);
    return { status: "pending", expiresAt: iso(pending.expiresAtMs) };
  }

  /** Fences asynchronous native promotion against canonical revocation. */
  beginAuthorityCheck(input: InFlightAuthorityCheck): TaskBindingAuthorityCheck {
    const check = { ...input };
    this.#authorityChecks.add(check);
    return {
      isCurrent: () => this.#authorityChecks.has(check),
      release: () => {
        this.#authorityChecks.delete(check);
      },
    };
  }

  #invalidateAuthorityChecks(matches: (check: InFlightAuthorityCheck) => boolean): void {
    for (const check of this.#authorityChecks) {
      if (matches(check)) {
        this.#authorityChecks.delete(check);
      }
    }
  }

  /** Native launch hooks reserve ownership but never activate a panel. */
  claimNative(input: {
    readonly bindProof: string;
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): TaskBindingClaimResult {
    this.#sweep();
    const proof = this.#proofsByHash.get(digestSecretHex(input.bindProof));
    if (proof?.native !== true) {
      this.#qualification?.record("claim-conflict", { taskSessionId: input.taskSessionId, reviewSessionId: input.reviewSessionId, generation: input.documentGeneration, denial: proof === undefined ? "proof-missing-or-expired" : "invalid" });
      return {
        status: "denied",
      };
    }
    this.#consumeProof(proof);
    if (proof.documentGeneration !== input.documentGeneration) this.#qualification?.record("claim-conflict", { taskSessionId: input.taskSessionId, reviewSessionId: input.reviewSessionId, generation: input.documentGeneration, denial: "generation-mismatch" });
    if (
      !validId(input.taskSessionId) ||
      proof.reviewSessionId !== input.reviewSessionId ||
      proof.documentGeneration !== input.documentGeneration ||
      !this.#associationAvailable(input)
    ) {
      return {
        status: "denied",
      };
    }
    this.#discardDifferentNativeHint(input.taskSessionId, input.reviewSessionId);
    this.#nativePending.set(proof.browserCapabilityHash, {
      ...input,
      browserCapabilityHash: proof.browserCapabilityHash,
      expiresAtMs: proof.expiresAtMs,
    });
    return {
      status: "pending",
      expiresAt: iso(proof.expiresAtMs),
    };
  }

  nativeClaimMatches(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): boolean {
    this.#sweep();
    const pending = this.#nativePending.get(input.browserCapabilityHash);
    return pending !== undefined &&
      pending.taskSessionId === input.taskSessionId &&
      pending.reviewSessionId === input.reviewSessionId &&
      pending.documentGeneration === input.documentGeneration;
  }

  activateNative(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): TaskBindingClaimResult {
    if (!this.nativeClaimMatches(input)) {
      return {
        status: "denied",
      };
    }
    const result = this.attachReconnectedNative(input);
    if (result.status === "active") {
      this.#nativePending.delete(input.browserCapabilityHash);
    }
    return result;
  }

  detachPresentation(capabilityHash: string): void {
    const proofHash = this.#proofHashByBrowserCapabilityHash.get(capabilityHash);
    const proof = proofHash === undefined ? undefined : this.#proofsByHash.get(proofHash);
    if (proof?.native === true) {
      this.#consumeProof(proof);
    }
    this.#nativePending.delete(capabilityHash);
    for (const active of this.#activeByTask.values()) {
      active.browserCapabilityHashes.delete(capabilityHash);
      if (active.browserCapabilityHashes.size === 0) {
        this.#removeActive(active);
      }
    }
  }

  rememberNativeReconnect(input: {
    readonly taskSessionId: string; readonly reviewSessionId: string; readonly documentGeneration: number;
    readonly browserCapabilityHash: string; readonly pdfPath: string;
  }): boolean {
    if (!this.hasPresentationAuthority(input)) return false;
    this.#nativeReconnectHints.delete(input.taskSessionId);
    if (!this.#validReconnectPath(input.pdfPath)) return false;
    this.#nativeReconnectHints.set(input.taskSessionId, {
      reviewSessionId: input.reviewSessionId, pdfPath: input.pdfPath, expiresAtMs: this.#nowMs() + 24 * 60 * 60_000,
    });
    while (this.#nativeReconnectHints.size > 256) this.#nativeReconnectHints.delete(this.#nativeReconnectHints.keys().next().value!);
    return true;
  }

  relocateNativeReconnect(reviewSessionId: string, pdfPath: string): void {
    for (const [task, hint] of this.#nativeReconnectHints) {
      if (hint.reviewSessionId !== reviewSessionId) continue;
      if (!this.#validReconnectPath(pdfPath)) this.#nativeReconnectHints.delete(task);
      else hint.pdfPath = pdfPath;
    }
  }

  nativeReconnectForTask(taskSessionId: string): NativeReconnectGuidance | undefined {
    this.#sweep();
    const hint = this.#nativeReconnectHints.get(taskSessionId);
    const owner = hint === undefined ? undefined : this.#activeByReview.get(hint.reviewSessionId);
    if (hint === undefined || (owner !== undefined && owner.taskSessionId !== taskSessionId)) return undefined;
    return { kind: "reopen-previous-source", pdfPath: hint.pdfPath, expiresAt: iso(hint.expiresAtMs) };
  }

  #validReconnectPath(path: string): boolean {
    return isAbsolute(path) && path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(path);
  }

  #discardDifferentNativeHint(taskSessionId: string, reviewSessionId: string): void {
    const hint = this.#nativeReconnectHints.get(taskSessionId);
    if (hint !== undefined && hint.reviewSessionId !== reviewSessionId) this.#nativeReconnectHints.delete(taskSessionId);
  }

  hasPresentationAuthority(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): boolean {
    this.#sweep();
    const active = this.#activeByTask.get(input.taskSessionId);
    return active?.reviewSessionId === input.reviewSessionId &&
      active.documentGeneration === input.documentGeneration &&
      active.browserCapabilityHashes.has(input.browserCapabilityHash);
  }

  #associationAvailable(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): boolean {
    const bindings = [
      ...this.#activeByTask.values(),
      ...this.#pendingByTask.values(),
      ...this.#nativePending.values(),
    ];
    for (const binding of bindings) {
      const fields = { taskSessionId: input.taskSessionId, reviewSessionId: input.reviewSessionId, generation: input.documentGeneration };
      if (binding.taskSessionId === input.taskSessionId && binding.reviewSessionId !== input.reviewSessionId) this.#qualification?.record("claim-conflict", { ...fields, denial: "task-associated-other-review" });
      if (binding.reviewSessionId === input.reviewSessionId && binding.taskSessionId !== input.taskSessionId) this.#qualification?.record("claim-conflict", { ...fields, denial: "review-owned-other-task" });
      if (binding.taskSessionId === input.taskSessionId && binding.reviewSessionId === input.reviewSessionId && binding.documentGeneration !== input.documentGeneration) this.#qualification?.record("claim-conflict", { ...fields, denial: "generation-mismatch" });
    }
    return bindings.every((binding) =>
      (binding.taskSessionId !== input.taskSessionId && binding.reviewSessionId !== input.reviewSessionId) ||
      (
        binding.taskSessionId === input.taskSessionId &&
        binding.reviewSessionId === input.reviewSessionId &&
        binding.documentGeneration === input.documentGeneration
      ));
  }

  activateBrowser(input: {
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapability: string;
  }): BrowserActivationResult {
    this.#sweep();
    if (
      !validId(input.reviewSessionId) ||
      !validGeneration(input.documentGeneration) ||
      !validId(input.browserCapability)
    ) return { status: "ignored" };

    const browserCapabilityHash = digestSecretHex(input.browserCapability);
    const pending = this.#pendingByReview.get(input.reviewSessionId);
    if (
      pending === undefined ||
      pending.documentGeneration !== input.documentGeneration ||
      pending.browserCapabilityHash !== browserCapabilityHash
    ) {
      // Browser-first activation is deliberately not recoverable: the task
      // claim must precede the exact authenticated bootstrap exchange.
      const unclaimedProofHash = this.#proofHashByBrowserCapabilityHash.get(browserCapabilityHash);
      if (unclaimedProofHash !== undefined) {
        const unclaimed = this.#proofsByHash.get(unclaimedProofHash);
        if (unclaimed !== undefined) this.#consumeProof(unclaimed);
      }
      return { status: "ignored" };
    }

    const existing = this.#activeByReview.get(input.reviewSessionId);
    if (existing !== undefined) {
      if (
        existing.taskSessionId !== pending.taskSessionId ||
        existing.documentGeneration !== pending.documentGeneration
      ) {
        return { status: "ignored" };
      }
      this.#removePending(pending);
      existing.browserCapabilityHashes.add(pending.browserCapabilityHash);
      existing.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
      return { status: "active", leaseExpiresAt: iso(existing.leaseExpiresAtMs) };
    }
    this.#removePending(pending);
    const active: ActiveBinding = {
      taskSessionId: pending.taskSessionId,
      reviewSessionId: pending.reviewSessionId,
      documentGeneration: pending.documentGeneration,
      browserCapabilityHashes: new Set([pending.browserCapabilityHash]),
      leaseExpiresAtMs: this.#nowMs() + this.#activeLeaseTtlMs,
    };
    this.#activeByTask.set(active.taskSessionId, active);
    this.#activeByReview.set(active.reviewSessionId, active);
    return { status: "active", leaseExpiresAt: iso(active.leaseExpiresAtMs) };
  }

  /** Completes a restart-only two-sided handshake after the successor has
   * authenticated the browser and independently matched the current task's
   * private reconnect ticket. The browser never supplies a task identity. */
  attachReconnectedBrowser(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): TaskBindingClaimResult {
    return this.#attachReconnectedPresentation(input, false);
  }

  attachReconnectedNative(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): TaskBindingClaimResult {
    return this.#attachReconnectedPresentation(input, true);
  }

  #attachReconnectedPresentation(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }, allowSameAssociationPending: boolean): TaskBindingClaimResult {
    this.#sweep();
    if (
      !validId(input.taskSessionId) ||
      !validId(input.reviewSessionId) ||
      !validGeneration(input.documentGeneration) ||
      !validSecretHash(input.browserCapabilityHash)
    ) return { status: "denied" };

    if (!this.#associationAvailable(input)) return { status: "denied" };
    this.#discardDifferentNativeHint(input.taskSessionId, input.reviewSessionId);
    const activeForReview = this.#activeByReview.get(input.reviewSessionId);
    const activeForTask = this.#activeByTask.get(input.taskSessionId);
    if (activeForReview !== undefined || activeForTask !== undefined) {
      if (
        activeForReview === activeForTask &&
        activeForReview?.taskSessionId === input.taskSessionId &&
        activeForReview.reviewSessionId === input.reviewSessionId &&
        activeForReview.documentGeneration === input.documentGeneration
      ) {
        activeForReview.browserCapabilityHashes.add(input.browserCapabilityHash);
        activeForReview.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
        return { status: "active", leaseExpiresAt: iso(activeForReview.leaseExpiresAtMs) };
      }
      return { status: "denied" };
    }

    const pendingForReview = this.#pendingByReview.get(input.reviewSessionId);
    const pendingForTask = this.#pendingByTask.get(input.taskSessionId);
    if (
      (pendingForReview !== undefined || pendingForTask !== undefined) &&
      !allowSameAssociationPending
    ) {
      return { status: "denied" };
    }

    const active: ActiveBinding = {
      taskSessionId: input.taskSessionId,
      reviewSessionId: input.reviewSessionId,
      documentGeneration: input.documentGeneration,
      browserCapabilityHashes: new Set([input.browserCapabilityHash]),
      leaseExpiresAtMs: this.#nowMs() + this.#activeLeaseTtlMs,
    };
    this.#expiredTasks.delete(input.taskSessionId);
    this.#activeByTask.set(active.taskSessionId, active);
    this.#activeByReview.set(active.reviewSessionId, active);
    return { status: "active", leaseExpiresAt: iso(active.leaseExpiresAtMs) };
  }

  renew(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): BrowserActivationResult {
    this.#sweep();
    const active = this.#activeByTask.get(input.taskSessionId);
    if (
      active === undefined ||
      active.reviewSessionId !== input.reviewSessionId ||
      active.documentGeneration !== input.documentGeneration
    ) return { status: "ignored" };
    active.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
    return { status: "active", leaseExpiresAt: iso(active.leaseExpiresAtMs) };
  }

  /** Renews the task already owning this exact review generation. The caller
   * must first authenticate a Codex-scoped browser credential; no task id is
   * accepted or returned across that browser boundary. */
  renewBrowserHeartbeat(input: {
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
    readonly browserCapabilityHash: string;
  }): BrowserActivationResult {
    this.#sweep();
    if (
      !validId(input.reviewSessionId) ||
      !validGeneration(input.documentGeneration)
    ) return { status: "ignored" };
    const active = this.#activeByReview.get(input.reviewSessionId);
    if (
      active === undefined ||
      active.documentGeneration !== input.documentGeneration ||
      !active.browserCapabilityHashes.has(input.browserCapabilityHash)
    ) return { status: "ignored" };
    active.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
    return { status: "active", leaseExpiresAt: iso(active.leaseExpiresAtMs) };
  }

  markVerified(taskSessionId: string, identity: LiveObservationIdentity): boolean {
    this.#sweep();
    const active = this.#activeByTask.get(taskSessionId);
    if (
      active === undefined ||
      active.reviewSessionId !== identity.placekeeperSessionId ||
      active.documentGeneration !== identity.documentGeneration
    ) return false;
    active.lastVerified = identity;
    active.leaseExpiresAtMs = this.#nowMs() + this.#activeLeaseTtlMs;
    return true;
  }

  bindingForTask(taskSessionId: string): ActiveTaskBinding | undefined {
    this.#sweep();
    const active = this.#activeByTask.get(taskSessionId);
    return active === undefined
      ? undefined
      : {
          reviewSessionId: active.reviewSessionId,
          documentGeneration: active.documentGeneration,
          leaseExpiresAt: iso(active.leaseExpiresAtMs),
          ...(active.lastVerified === undefined ? {} : { lastVerified: active.lastVerified }),
        };
  }

  taskForGeneration(reviewSessionId: string, documentGeneration: number): string | undefined {
    this.#sweep();
    const active = this.#activeByReview.get(reviewSessionId);
    return active?.documentGeneration === documentGeneration ? active.taskSessionId : undefined;
  }

  unavailableReasonForTask(taskSessionId: string): "pending" | "expired" | "unbound" {
    this.#sweep();
    if (this.#pendingByTask.has(taskSessionId) || [...this.#nativePending.values()].some((pending) => pending.taskSessionId === taskSessionId)) return "pending";
    return this.#expiredTasks.has(taskSessionId) ? "expired" : "unbound";
  }

  statusForReview(
    reviewSessionId: string,
    live: LiveReviewIdentity,
    browserCapabilityHash: string,
  ): LiveContextBindingStatus {
    this.#sweep();
    const active = this.#activeByReview.get(reviewSessionId);
    if (
      active?.documentGeneration === live.documentGeneration &&
      active.browserCapabilityHashes.has(browserCapabilityHash)
    ) {
      const verified = active.lastVerified;
      const verifiedCurrent =
        verified !== undefined &&
        verified.placekeeperSessionId === reviewSessionId &&
        verified.documentGeneration === live.documentGeneration &&
        verified.reviewRevision === live.reviewRevision &&
        verified.source.digest === live.sourceDigest &&
        verified.stateDigest === live.stateDigest;
      return !verifiedCurrent
        ? {
            status: "refreshing",
            placekeeperSessionId: reviewSessionId,
            documentGeneration: live.documentGeneration,
            ...(verified === undefined ? {} : { lastVerified: verified }),
          }
        : {
            status: "current",
            identity: verified,
            leaseExpiresAt: iso(active.leaseExpiresAtMs),
          };
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (
      pending?.documentGeneration === live.documentGeneration &&
      pending.browserCapabilityHash === browserCapabilityHash
    ) {
      return {
        status: "pending",
        placekeeperSessionId: reviewSessionId,
        documentGeneration: live.documentGeneration,
        expiresAt: iso(pending.expiresAtMs),
      };
    }
    for (const proof of this.#proofsByHash.values()) {
      if (
        proof.reviewSessionId === reviewSessionId &&
        proof.documentGeneration === live.documentGeneration &&
        proof.browserCapabilityHash === browserCapabilityHash
      ) {
        return {
          status: "pending",
          placekeeperSessionId: reviewSessionId,
          documentGeneration: live.documentGeneration,
          expiresAt: iso(proof.expiresAtMs),
        };
      }
    }
    return { status: "unbound" };
  }

  revokeTask(taskSessionId: string): void {
    this.#nativeReconnectHints.delete(taskSessionId);
    this.#invalidateAuthorityChecks((check) => check.taskSessionId === taskSessionId);
    for (const [key, pending] of this.#nativePending) {
      if (pending.taskSessionId === taskSessionId) {
        this.#nativePending.delete(key);
      }
    }
    const pending = this.#pendingByTask.get(taskSessionId);
    if (pending !== undefined) {
      this.#removePending(pending);
    }
    const active = this.#activeByTask.get(taskSessionId);
    if (active !== undefined) {
      this.#removeActive(active);
    }
    this.#expiredTasks.delete(taskSessionId);
  }

  revokeSession(reviewSessionId: string): void {
    for (const [task, hint] of this.#nativeReconnectHints) if (hint.reviewSessionId === reviewSessionId) this.#nativeReconnectHints.delete(task);
    this.#invalidateAuthorityChecks((check) => check.reviewSessionId === reviewSessionId);
    for (const [key, pending] of this.#nativePending) {
      if (pending.reviewSessionId === reviewSessionId) {
        this.#nativePending.delete(key);
      }
    }
    for (const proof of [...this.#proofsByHash.values()]) {
      if (proof.reviewSessionId === reviewSessionId) {
        this.#consumeProof(proof);
      }
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (pending !== undefined) {
      this.#removePending(pending);
    }
    const active = this.#activeByReview.get(reviewSessionId);
    if (active !== undefined) {
      this.#removeActive(active);
    }
  }

  revokeGeneration(reviewSessionId: string, currentGeneration: number): void {
    this.#invalidateAuthorityChecks((check) =>
      check.reviewSessionId === reviewSessionId && check.documentGeneration !== currentGeneration);
    for (const [key, pending] of this.#nativePending) {
      if (
        pending.reviewSessionId === reviewSessionId &&
        pending.documentGeneration !== currentGeneration
      ) {
        this.#nativePending.delete(key);
      }
    }
    for (const proof of [...this.#proofsByHash.values()]) {
      if (
        proof.reviewSessionId === reviewSessionId &&
        proof.documentGeneration !== currentGeneration
      ) {
        this.#consumeProof(proof);
      }
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (
      pending !== undefined &&
      pending.documentGeneration !== currentGeneration
    ) {
      this.#removePending(pending);
    }
    const active = this.#activeByReview.get(reviewSessionId);
    if (
      active !== undefined &&
      active.documentGeneration !== currentGeneration
    ) {
      this.#removeActive(active);
    }
  }

  /** Advances only the exact active lease already owning this review. Pending,
   * expired, foreign-generation, and proof-only authority is revoked. */
  migrateGeneration(input: {
    readonly reviewSessionId: string;
    readonly previousGeneration: number;
    readonly successorGeneration: number;
  }): GenerationMigrationResult {
    this.#sweep();
    this.#invalidateAuthorityChecks((check) => check.reviewSessionId === input.reviewSessionId);
    if (
      !validId(input.reviewSessionId) ||
      !validGeneration(input.previousGeneration) ||
      !validGeneration(input.successorGeneration) ||
      input.successorGeneration <= input.previousGeneration
    ) {
      return {
        status: "revoked",
      };
    }
    for (const proof of [...this.#proofsByHash.values()]) {
      if (proof.reviewSessionId === input.reviewSessionId) {
        this.#consumeProof(proof);
      }
    }
    for (const [key, pending] of this.#nativePending) {
      if (pending.reviewSessionId === input.reviewSessionId) {
        this.#nativePending.delete(key);
      }
    }
    const pending = this.#pendingByReview.get(input.reviewSessionId);
    if (pending !== undefined) {
      this.#removePending(pending);
    }
    const active = this.#activeByReview.get(input.reviewSessionId);
    if (active === undefined) {
      return {
        status: "unbound",
      };
    }
    if (active.documentGeneration !== input.previousGeneration) {
      this.#removeActive(active);
      return {
        status: "revoked",
      };
    }
    active.documentGeneration = input.successorGeneration;
    delete active.lastVerified;
    return {
      status: "migrated",
      taskSessionId: active.taskSessionId,
    };
  }

  revokeAll(): void {
    this.#nativeReconnectHints.clear();
    this.#authorityChecks.clear();
    this.#nativePending.clear();
    this.#proofsByHash.clear();
    this.#proofHashByBrowserCapabilityHash.clear();
    this.#pendingByTask.clear();
    this.#pendingByReview.clear();
    this.#activeByTask.clear();
    this.#activeByReview.clear();
    this.#expiredTasks.clear();
  }

  activityCount(): number {
    this.#sweep();
    return this.#authorityChecks.size + this.#nativePending.size + this.#proofsByHash.size + this.#pendingByTask.size + this.#activeByTask.size;
  }

  #nowMs(): number {
    return this.#now().getTime();
  }

  #consumeProof(proof: BindProofRecord): void {
    this.#proofsByHash.delete(proof.proofHash);
    this.#proofHashByBrowserCapabilityHash.delete(proof.browserCapabilityHash);
  }

  #removePending(binding: PendingBinding): void {
    if (this.#pendingByTask.get(binding.taskSessionId) === binding) {
      this.#pendingByTask.delete(binding.taskSessionId);
    }
    if (this.#pendingByReview.get(binding.reviewSessionId) === binding) {
      this.#pendingByReview.delete(binding.reviewSessionId);
    }
  }

  #removeActive(binding: ActiveBinding): void {
    if (this.#activeByTask.get(binding.taskSessionId) === binding) {
      this.#activeByTask.delete(binding.taskSessionId);
    }
    if (this.#activeByReview.get(binding.reviewSessionId) === binding) {
      this.#activeByReview.delete(binding.reviewSessionId);
    }
  }

  #sweep(): void {
    const now = this.#nowMs();
    for (const [task, hint] of this.#nativeReconnectHints) if (hint.expiresAtMs <= now) this.#nativeReconnectHints.delete(task);
    for (const [key, pending] of this.#nativePending) {
      if (pending.expiresAtMs <= now) {
        this.#nativePending.delete(key);
      }
    }
    for (const proof of [...this.#proofsByHash.values()]) {
      if (proof.expiresAtMs <= now) {
        this.#consumeProof(proof);
      }
    }
    for (const pending of [...this.#pendingByTask.values()]) {
      if (pending.expiresAtMs <= now) {
        this.#expiredTasks.set(pending.taskSessionId, now);
        this.#removePending(pending);
      }
    }
    for (const active of [...this.#activeByTask.values()]) {
      if (active.leaseExpiresAtMs <= now) {
        this.#expiredTasks.set(active.taskSessionId, now);
        this.#removeActive(active);
      }
    }
    while (this.#expiredTasks.size > 256) {
      const oldest = this.#expiredTasks.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#expiredTasks.delete(oldest);
    }
  }
}
