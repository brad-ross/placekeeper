import { randomBytes } from "node:crypto";
import {
  RecoveryOfferUnavailableError,
  type OpenReviewResult,
  type RecoveryDecision,
  type RecoveryOfferIdentity,
} from "./session-contracts.js";
import type { RecoveryOfferRecord, RecoveryOperationRecord } from "./session-internal-types.js";

const RECOVERY_OFFER_TTL_MS = 5 * 60_000;
export const RECOVERY_ID = /^[A-Za-z0-9_-]{16,128}$/u;
type RecoveryTarget = Pick<RecoveryOfferRecord, "recoverySessionId" | "recoveredSourceDigest" | "canonicalSourcePath" | "requestedSourceDigest">;

/** Ephemeral decision records only; session mutation and persistence remain broker-owned. */
export class RecoveryDecisions {
  readonly #offers = new Map<string, RecoveryOfferRecord>();
  readonly #operations = new Map<string, RecoveryOperationRecord>();
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  offer(target: RecoveryTarget): RecoveryOfferIdentity {
    const currentOffer = [...this.#offers.entries()].find(([, offer]) =>
      offer.expiresAtMs > this.#now().getTime() &&
      offer.recoverySessionId === target.recoverySessionId &&
      offer.recoveredSourceDigest === target.recoveredSourceDigest &&
      offer.canonicalSourcePath === target.canonicalSourcePath &&
      offer.requestedSourceDigest === target.requestedSourceDigest
    );
    const recoveryOffer = currentOffer === undefined
      ? {
          id: randomBytes(24).toString("base64url"),
          expiresAt: new Date(this.#now().getTime() + RECOVERY_OFFER_TTL_MS).toISOString(),
        } satisfies RecoveryOfferIdentity
      : { id: currentOffer[0], expiresAt: currentOffer[1].expiresAt };
    if (currentOffer === undefined) {
      this.#offers.set(recoveryOffer.id, {
        expiresAt: recoveryOffer.expiresAt,
        recoverySessionId: target.recoverySessionId,
        recoveredSourceDigest: target.recoveredSourceDigest,
        canonicalSourcePath: target.canonicalSourcePath,
        requestedSourceDigest: target.requestedSourceDigest,
        expiresAtMs: Date.parse(recoveryOffer.expiresAt),
      });
    }
    return recoveryOffer;
  }

  claim(
    identity: RecoveryOfferIdentity,
    operationId: string,
    decision: RecoveryDecision,
    target: RecoveryTarget | undefined,
  ): void {
    const offer = this.#offers.get(identity.id);
    if (
      offer === undefined ||
      offer.expiresAt !== identity.expiresAt ||
      offer.expiresAtMs <= this.#now().getTime() ||
      target === undefined ||
      offer.recoverySessionId !== target.recoverySessionId ||
      offer.recoveredSourceDigest !== target.recoveredSourceDigest ||
      offer.canonicalSourcePath !== target.canonicalSourcePath ||
      offer.requestedSourceDigest !== target.requestedSourceDigest
    ) {
      throw new RecoveryOfferUnavailableError(
        "Recovery offer is stale, expired, or does not match this protected draft",
      );
    }
    if (
      offer.claimedOperationId !== undefined &&
      (offer.claimedOperationId !== operationId ||
        offer.claimedDecision !== decision)
    ) {
      throw new RecoveryOfferUnavailableError(
        "Recovery offer was already used by a different operation or choice",
      );
    }
    offer.claimedOperationId = operationId;
    offer.claimedDecision = decision;
    for (const [siblingId, sibling] of this.#offers) {
      if (
        siblingId !== identity.id &&
        sibling.recoverySessionId === offer.recoverySessionId
      ) {
        this.#deleteOffer(siblingId);
      }
    }
  }

  operation(operationId: string): RecoveryOperationRecord | undefined {
    return this.#operations.get(operationId);
  }

  startOperation(
    operationId: string,
    offerId: string,
    fingerprint: string,
    open: () => Promise<OpenReviewResult>,
  ): Promise<OpenReviewResult> {
    const offered = this.#offers.get(offerId);
    const result = open();
    this.#operations.set(operationId, {
      fingerprint, result, offerId,
      ...(offered === undefined ? {} : { recoverySessionId: offered.recoverySessionId }),
      expiresAtMs: offered?.expiresAtMs ?? this.#now().getTime() + RECOVERY_OFFER_TTL_MS,
    });
    return result;
  }

  failOperation(operationId: string, offerId: string): void {
    this.#operations.delete(operationId);
    const offer = this.#offers.get(offerId);
    if (offer?.claimedOperationId === operationId) {
      delete offer.claimedOperationId;
      delete offer.claimedDecision;
    }
  }

  sweep(): void {
    const now = this.#now().getTime();
    for (const [offerId, offer] of this.#offers) {
      if (offer.expiresAtMs <= now) this.#deleteOffer(offerId);
    }
    for (const [operationId, operation] of this.#operations) {
      if (operation.expiresAtMs <= now || !this.#offers.has(operation.offerId)) {
        this.#operations.delete(operationId);
      }
    }
  }

  #deleteOffer(offerId: string): void {
    this.#offers.delete(offerId);
    for (const [operationId, operation] of this.#operations) {
      if (operation.offerId === offerId) this.#operations.delete(operationId);
    }
  }

  clearForSession(sessionId: string): void {
    const removedOffers = new Set<string>();
    for (const [offerId, offer] of this.#offers) {
      if (offer.recoverySessionId === sessionId) {
        removedOffers.add(offerId);
        this.#offers.delete(offerId);
      }
    }
    for (const [operationId, operation] of this.#operations) {
      if (operation.recoverySessionId === sessionId || removedOffers.has(operation.offerId)) {
        this.#operations.delete(operationId);
      }
    }
  }

  clear(): void {
    this.#offers.clear();
    this.#operations.clear();
  }
}
