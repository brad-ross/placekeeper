import { randomBytes } from "node:crypto";

import type {
  LiveContextBindingStatus,
  LiveObservationIdentity,
} from "../../../../packages/core/src/live-context.js";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";

const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_ACTIVE_LEASE_TTL_MS = 15 * 60_000;
const MAX_ID_LENGTH = 512;

interface BindProofRecord {
  readonly proofHash: string;
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
  readonly documentGeneration: number;
  leaseExpiresAtMs: number;
  lastVerified?: LiveObservationIdentity;
}

export interface TaskBindingRegistryOptions {
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

export type TaskBindingClaimResult =
  | { readonly status: "pending"; readonly expiresAt: string }
  | { readonly status: "active"; readonly leaseExpiresAt: string }
  | { readonly status: "denied" };

export type BrowserActivationResult =
  | { readonly status: "active"; readonly leaseExpiresAt: string }
  | { readonly status: "ignored" };

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
  readonly #pendingTtlMs: number;
  readonly #activeLeaseTtlMs: number;
  readonly #randomProof: () => string;
  readonly #proofsByHash = new Map<string, BindProofRecord>();
  readonly #proofHashByBrowserCapabilityHash = new Map<string, string>();
  readonly #pendingByTask = new Map<string, PendingBinding>();
  readonly #pendingByReview = new Map<string, PendingBinding>();
  readonly #activeByTask = new Map<string, ActiveBinding>();
  readonly #activeByReview = new Map<string, ActiveBinding>();

  constructor(options: TaskBindingRegistryOptions = {}) {
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
    const proof = this.#proofsByHash.get(proofHash);
    if (proof === undefined) return { status: "denied" };
    this.#consumeProof(proof);
    if (
      proof.reviewSessionId !== input.reviewSessionId ||
      proof.documentGeneration !== input.documentGeneration ||
      proof.expiresAtMs <= this.#nowMs()
    ) return { status: "denied" };

    const activeForReview = this.#activeByReview.get(input.reviewSessionId);
    const activeForTask = this.#activeByTask.get(input.taskSessionId);
    if (activeForReview !== undefined || activeForTask !== undefined) {
      if (
        activeForReview === activeForTask &&
        activeForReview?.taskSessionId === input.taskSessionId &&
        activeForReview.reviewSessionId === input.reviewSessionId &&
        activeForReview.documentGeneration === input.documentGeneration
      ) {
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

    this.#removePending(pending);
    const active: ActiveBinding = {
      taskSessionId: pending.taskSessionId,
      reviewSessionId: pending.reviewSessionId,
      documentGeneration: pending.documentGeneration,
      leaseExpiresAtMs: this.#nowMs() + this.#activeLeaseTtlMs,
    };
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

  markVerified(taskSessionId: string, identity: LiveObservationIdentity): boolean {
    this.#sweep();
    const active = this.#activeByTask.get(taskSessionId);
    if (
      active === undefined ||
      active.reviewSessionId !== identity.proofreaderSessionId ||
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

  statusForReview(
    reviewSessionId: string,
    documentGeneration: number,
  ): LiveContextBindingStatus {
    this.#sweep();
    const active = this.#activeByReview.get(reviewSessionId);
    if (active?.documentGeneration === documentGeneration) {
      return active.lastVerified === undefined
        ? {
            status: "refreshing",
            proofreaderSessionId: reviewSessionId,
            documentGeneration,
          }
        : {
            status: "current",
            identity: active.lastVerified,
            leaseExpiresAt: iso(active.leaseExpiresAtMs),
          };
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (pending?.documentGeneration === documentGeneration) {
      return {
        status: "pending",
        proofreaderSessionId: reviewSessionId,
        documentGeneration,
        expiresAt: iso(pending.expiresAtMs),
      };
    }
    for (const proof of this.#proofsByHash.values()) {
      if (
        proof.reviewSessionId === reviewSessionId &&
        proof.documentGeneration === documentGeneration
      ) {
        return {
          status: "pending",
          proofreaderSessionId: reviewSessionId,
          documentGeneration,
          expiresAt: iso(proof.expiresAtMs),
        };
      }
    }
    return { status: "unbound" };
  }

  revokeTask(taskSessionId: string): void {
    const pending = this.#pendingByTask.get(taskSessionId);
    if (pending !== undefined) this.#removePending(pending);
    const active = this.#activeByTask.get(taskSessionId);
    if (active !== undefined) this.#removeActive(active);
  }

  revokeSession(reviewSessionId: string): void {
    for (const proof of [...this.#proofsByHash.values()]) {
      if (proof.reviewSessionId === reviewSessionId) this.#consumeProof(proof);
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (pending !== undefined) this.#removePending(pending);
    const active = this.#activeByReview.get(reviewSessionId);
    if (active !== undefined) this.#removeActive(active);
  }

  revokeGeneration(reviewSessionId: string, currentGeneration: number): void {
    for (const proof of [...this.#proofsByHash.values()]) {
      if (
        proof.reviewSessionId === reviewSessionId &&
        proof.documentGeneration !== currentGeneration
      ) this.#consumeProof(proof);
    }
    const pending = this.#pendingByReview.get(reviewSessionId);
    if (pending !== undefined && pending.documentGeneration !== currentGeneration) {
      this.#removePending(pending);
    }
    const active = this.#activeByReview.get(reviewSessionId);
    if (active !== undefined && active.documentGeneration !== currentGeneration) {
      this.#removeActive(active);
    }
  }

  revokeAll(): void {
    this.#proofsByHash.clear();
    this.#proofHashByBrowserCapabilityHash.clear();
    this.#pendingByTask.clear();
    this.#pendingByReview.clear();
    this.#activeByTask.clear();
    this.#activeByReview.clear();
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
    for (const proof of [...this.#proofsByHash.values()]) {
      if (proof.expiresAtMs <= now) this.#consumeProof(proof);
    }
    for (const pending of [...this.#pendingByTask.values()]) {
      if (pending.expiresAtMs <= now) this.#removePending(pending);
    }
    for (const active of [...this.#activeByTask.values()]) {
      if (active.leaseExpiresAtMs <= now) this.#removeActive(active);
    }
  }
}
