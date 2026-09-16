import { createHash, randomBytes } from "node:crypto";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";

export const REVIEW_INTERACTION_PROTOCOL_VERSION = 1 as const;
export const REVIEW_INTERACTION_CAPABILITIES = [
  "session-wide-holds",
  "durable-finalize-receipts",
  "connection-incarnations",
] as const;

export type ReviewInteractionOutcome = "applied" | "discarded";

export interface ReviewInteractionAttachment {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly incarnationId: string;
  readonly capability: string;
  readonly protocolVersion: typeof REVIEW_INTERACTION_PROTOCOL_VERSION;
  readonly capabilities: typeof REVIEW_INTERACTION_CAPABILITIES;
}

export interface ReviewInteractionReceipt {
  readonly status: "finalized";
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly interactionToken: string;
  readonly generation: number;
  readonly outcome: ReviewInteractionOutcome;
  readonly reviewRevision: number;
}

type LifecycleResult =
  | { readonly status: "accepted"; readonly generation: number; readonly ownerViewId: string }
  | { readonly status: "released" | "missing" | "unauthorized" | "out-of-order" }
  | { readonly status: "stale"; readonly generation: number }
  | { readonly status: "backpressure" }
  | ReviewInteractionReceipt;

interface AttachmentRecord {
  readonly sessionId: string;
  readonly ownerKey: string;
  readonly attachmentId: string;
  readonly incarnationId: string;
  readonly capabilityHash: string;
  readonly holds: Map<string, { readonly generation: number; lastOrder: number }>;
  readonly terminalFences: Map<string, number>;
  lastOrder: number;
  revoked: boolean;
}

interface AuthenticatedOperation {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly incarnationId: string;
  readonly capability: string;
  readonly interactionToken: string;
  readonly order: number;
}

export interface ReviewInteractionsOptions {
  readonly currentGeneration: (sessionId: string) => number | undefined;
  readonly persistReceipt?: (receipt: ReviewInteractionReceipt) => Promise<void>;
  readonly onLastRelease?: (sessionId: string) => void;
  readonly maxPendingReceipts?: number;
  readonly maxTerminalFences?: number;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function receiptKey(ownerKey: string, interactionToken: string): string {
  return `${ownerKey}\0${interactionToken}`;
}

function stableAttachmentId(stableOwner: string): string {
  return `attachment_${createHash("sha256").update(stableOwner).digest("base64url").slice(0, 32)}`;
}

/**
 * Attachment authority for a review session. Holds belong to one live
 * connection incarnation. Terminal receipts use a stable attachment identity
 * and can be hydrated from recovery so reconnect can recover an uncertain
 * finalize without authorizing the old connection.
 */
export class ReviewInteractions {
  readonly #options: ReviewInteractionsOptions;
  readonly #attachments = new Map<string, AttachmentRecord>();
  readonly #attachmentByOwner = new Map<string, string>();
  readonly #receipts = new Map<string, ReviewInteractionReceipt>();

  constructor(options: ReviewInteractionsOptions) {
    this.#options = options;
  }

  register(sessionId: string, ownerKey: string): ReviewInteractionAttachment {
    const stableOwner = `${sessionId}\0${ownerKey}`;
    const previousId = this.#attachmentByOwner.get(stableOwner);
    const previous = previousId === undefined ? undefined : this.#attachments.get(previousId);
    const attachmentId = previous?.attachmentId ?? stableAttachmentId(stableOwner);
    if (previous !== undefined) {
      previous.revoked = true;
      this.#attachments.delete(previous.attachmentId);
      this.#releaseAll(previous);
    }
    const capability = randomBytes(32).toString("base64url");
    const record: AttachmentRecord = {
      sessionId,
      ownerKey: stableOwner,
      attachmentId,
      incarnationId: opaque("incarnation"),
      capabilityHash: digestSecretHex(capability),
      holds: new Map(),
      terminalFences: new Map(),
      lastOrder: 0,
      revoked: false,
    };
    this.#attachments.set(attachmentId, record);
    this.#attachmentByOwner.set(stableOwner, attachmentId);
    return {
      sessionId,
      attachmentId,
      incarnationId: record.incarnationId,
      capability,
      protocolVersion: REVIEW_INTERACTION_PROTOCOL_VERSION,
      capabilities: REVIEW_INTERACTION_CAPABILITIES,
    };
  }

  held(sessionId: string): boolean {
    for (const record of this.#attachments.values()) {
      if (!record.revoked && record.sessionId === sessionId && record.holds.size > 0) return true;
    }
    return false;
  }

  authorize(
    input: Pick<AuthenticatedOperation, "sessionId" | "attachmentId" | "incarnationId" | "capability">,
  ): boolean {
    return this.#authenticate(input) !== undefined;
  }

  hydrate(receipts: readonly ReviewInteractionReceipt[]): void {
    for (const receipt of receipts) {
      this.#receipts.set(receiptKey(receipt.attachmentId, receipt.interactionToken), receipt);
    }
  }

  recoverFinalized(receipt: ReviewInteractionReceipt): void {
    this.#receipts.set(receiptKey(receipt.attachmentId, receipt.interactionToken), receipt);
    const record = this.#attachments.get(receipt.attachmentId);
    if (record?.sessionId === receipt.sessionId) {
      record.holds.delete(receipt.interactionToken);
      this.#notifyIfLast(receipt.sessionId);
    }
  }

  recoverAcknowledged(attachmentId: string, interactionToken: string): void {
    this.#receipts.delete(receiptKey(attachmentId, interactionToken));
  }

  async begin(input: AuthenticatedOperation & { readonly generation: number }): Promise<LifecycleResult> {
    const record = this.#authenticate(input);
    if (record === undefined) return { status: "unauthorized" };
    const receipt = this.#receipt(input);
    if (receipt !== undefined) return receipt;
    const currentGeneration = this.#options.currentGeneration(input.sessionId);
    if (currentGeneration === undefined || input.generation !== currentGeneration) {
      return { status: "stale", generation: currentGeneration ?? input.generation };
    }
    const existing = record.holds.get(input.interactionToken);
    if (existing !== undefined) {
      return existing.generation === input.generation
        ? { status: "accepted", generation: existing.generation, ownerViewId: record.attachmentId }
        : { status: "stale", generation: currentGeneration };
    }
    const terminalOrder = record.terminalFences.get(input.interactionToken);
    if (terminalOrder !== undefined) {
      if (!Number.isSafeInteger(input.order) || input.order <= terminalOrder) {
        return { status: "out-of-order" };
      }
      record.terminalFences.delete(input.interactionToken);
    }
    if (!this.#acceptOrder(record, input.order)) return { status: "out-of-order" };
    record.holds.set(input.interactionToken, { generation: input.generation, lastOrder: input.order });
    return { status: "accepted", generation: input.generation, ownerViewId: record.attachmentId };
  }

  async release(input: AuthenticatedOperation): Promise<LifecycleResult> {
    const record = this.#authenticate(input);
    if (record === undefined) return { status: "unauthorized" };
    const receipt = this.#receipt(input);
    if (receipt !== undefined) return receipt;
    const hold = record.holds.get(input.interactionToken);
    if (hold === undefined) {
      if (!Number.isSafeInteger(input.order) || input.order <= 0) return { status: "out-of-order" };
      this.#recordTerminalFence(record, input.interactionToken, input.order);
      return { status: "missing" };
    }
    if (!this.#acceptActiveTokenOrder(record, hold, input.order)) return { status: "out-of-order" };
    record.holds.delete(input.interactionToken);
    this.#notifyIfLast(record.sessionId);
    return { status: "released" };
  }

  async finalize(input: AuthenticatedOperation & {
    readonly outcome: ReviewInteractionOutcome;
    readonly reviewRevision?: number;
    readonly commit?: () => Promise<number | {
      readonly reviewRevision: number;
      readonly persist: (receipt: ReviewInteractionReceipt) => Promise<void>;
    }>;
  }): Promise<LifecycleResult> {
    const record = this.#authenticate(input);
    if (record === undefined) return { status: "unauthorized" };
    const replay = this.#receipt(input);
    if (replay !== undefined) return replay;
    const hold = record.holds.get(input.interactionToken);
    if (hold === undefined) return { status: "missing" };
    if (!Number.isSafeInteger(input.order) || input.order <= hold.lastOrder) return { status: "out-of-order" };
    const maximum = this.#options.maxPendingReceipts ?? 256;
    if (this.#receipts.size >= maximum) return { status: "backpressure" };
    const committed = input.commit === undefined
      ? input.reviewRevision
      : await input.commit();
    const reviewRevision = typeof committed === "object" && committed !== null
      ? committed.reviewRevision : committed;
    if (!Number.isSafeInteger(reviewRevision) || (reviewRevision as number) < 0) {
      throw new Error("A terminal interaction receipt requires an authoritative review revision");
    }
    const receipt: ReviewInteractionReceipt = {
      status: "finalized",
      sessionId: record.sessionId,
      attachmentId: record.attachmentId,
      interactionToken: input.interactionToken,
      generation: hold.generation,
      outcome: input.outcome,
      reviewRevision: reviewRevision as number,
    };
    // Persistence is the commit point. A rejection leaves both the editor hold
    // and its retry identity intact.
    if (typeof committed === "object" && committed !== null) await committed.persist(receipt);
    else await this.#options.persistReceipt?.(receipt);
    this.#receipts.set(receiptKey(record.attachmentId, input.interactionToken), receipt);
    record.lastOrder = Math.max(record.lastOrder, input.order);
    hold.lastOrder = input.order;
    record.holds.delete(input.interactionToken);
    this.#notifyIfLast(record.sessionId);
    return receipt;
  }

  async acknowledge(input: AuthenticatedOperation & {
    readonly persist?: (receipt: ReviewInteractionReceipt) => Promise<void>;
  }): Promise<LifecycleResult> {
    const record = this.#authenticate(input);
    if (record === undefined) return { status: "unauthorized" };
    const key = receiptKey(record.attachmentId, input.interactionToken);
    const receipt = this.#receipts.get(key);
    if (receipt === undefined) return { status: "missing" };
    await input.persist?.(receipt);
    this.#receipts.delete(key);
    return { status: "released" };
  }

  disconnect(attachmentId: string, incarnationId: string): void {
    const record = this.#attachments.get(attachmentId);
    if (record === undefined || record.incarnationId !== incarnationId) return;
    record.revoked = true;
    this.#attachments.delete(attachmentId);
    this.#releaseAll(record);
  }

  revokeSession(sessionId: string): void {
    for (const record of [...this.#attachments.values()]) {
      if (record.sessionId !== sessionId) continue;
      record.revoked = true;
      this.#attachments.delete(record.attachmentId);
      record.holds.clear();
    }
    for (const [key, receipt] of this.#receipts) {
      if (receipt.sessionId === sessionId) this.#receipts.delete(key);
    }
    const ownerPrefix = `${sessionId}\0`;
    for (const ownerKey of this.#attachmentByOwner.keys()) {
      if (ownerKey.startsWith(ownerPrefix)) this.#attachmentByOwner.delete(ownerKey);
    }
  }

  #authenticate(input: Pick<AuthenticatedOperation, "sessionId" | "attachmentId" | "incarnationId" | "capability">): AttachmentRecord | undefined {
    const record = this.#attachments.get(input.attachmentId);
    return record !== undefined && !record.revoked && record.sessionId === input.sessionId &&
      record.incarnationId === input.incarnationId && record.capabilityHash === digestSecretHex(input.capability)
      ? record : undefined;
  }

  #receipt(input: Pick<AuthenticatedOperation, "sessionId" | "attachmentId" | "interactionToken">): ReviewInteractionReceipt | undefined {
    const record = this.#attachments.get(input.attachmentId);
    if (record === undefined || record.sessionId !== input.sessionId) return undefined;
    return this.#receipts.get(receiptKey(record.attachmentId, input.interactionToken));
  }

  #acceptOrder(record: AttachmentRecord, order: number): boolean {
    if (!Number.isSafeInteger(order) || order <= record.lastOrder) return false;
    record.lastOrder = order;
    return true;
  }

  #acceptActiveTokenOrder(
    record: AttachmentRecord,
    hold: { lastOrder: number },
    order: number,
  ): boolean {
    if (!Number.isSafeInteger(order) || order <= hold.lastOrder) return false;
    hold.lastOrder = order;
    record.lastOrder = Math.max(record.lastOrder, order);
    return true;
  }

  #recordTerminalFence(record: AttachmentRecord, interactionToken: string, order: number): void {
    const previous = record.terminalFences.get(interactionToken);
    if (previous === undefined || order > previous) {
      record.terminalFences.delete(interactionToken);
      record.terminalFences.set(interactionToken, order);
    }
    record.lastOrder = Math.max(record.lastOrder, order);
    const maximum = Math.max(0, this.#options.maxTerminalFences ?? 256);
    while (record.terminalFences.size > maximum) {
      const oldest = record.terminalFences.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      record.terminalFences.delete(oldest);
    }
  }

  #releaseAll(record: AttachmentRecord): void {
    const hadHolds = record.holds.size > 0;
    record.holds.clear();
    if (hadHolds) this.#notifyIfLast(record.sessionId);
  }

  #notifyIfLast(sessionId: string): void {
    if (!this.held(sessionId)) this.#options.onLastRelease?.(sessionId);
  }
}
