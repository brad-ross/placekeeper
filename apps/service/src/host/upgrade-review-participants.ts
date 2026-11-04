import type { UpgradeReviewSettlement, UpgradeReviewStatus } from '../../../../packages/core/src/upgrade-review-protocol.js';
import type { UpgradeParticipantCredentials, UpgradePreparationCoordinator } from './upgrade-preparation.js';
import type { SessionBroker } from '../sessions/session-broker.js';
import type { PdfSaveCoordinator } from '../saving/pdf-save-coordinator.js';

interface ReviewProtection {
  readonly revision: () => string;
  readonly generation?: () => number;
  /** Resolves only after recovery protection, broker writes and PDF saves are durable. */
  readonly protect: () => Promise<void>;
}
export function createUpgradeReviewProtection(broker: SessionBroker, saving: PdfSaveCoordinator, sessionId: string): ReviewProtection {
  return {
    generation: () => broker.state(sessionId)?.workflow.documentGeneration ?? -1,
    revision: () => {
      const state = broker.state(sessionId);
      if (!state) throw new Error('Review ended');
      return `${state.workflow.documentGeneration}:${state.revision}`;
    },
    protect: async () => {
      await broker.protectChromeReview(sessionId);
      await saving.drain();
      await broker.drainWrites();
      const status = broker.saveStatus(sessionId);
      if (status?.destination.phase === 'active' && status.sync.phase !== 'clean') throw new Error('PDF save failed');
    },
  };
}
/** Trusted adapters key participants by admitted connection ownership, never renderer IDs. */
export class UpgradeReviewParticipants {
  readonly #views = new Map<string, { credentials: UpgradeParticipantCredentials; protection: ReviewProtection; generation: number | undefined; retiring?: boolean }>();
  constructor(readonly coordinator: UpgradePreparationCoordinator) {}
  retireMetadata(id: string): void {
    const view = this.#views.get(id);
    if (!view || this.coordinator.poll(view.credentials)?.phase !== 'committed' || (!id.startsWith('app:') && id !== 'task-authority')) throw new Error('Metadata retirement requires committed closure');
    view.retiring = true;
  }
  assertAuthoring(id: string): void {
    const status = this.poll(id);
    if (status.phase === 'ready' || status.phase === 'committed' || (status.phase === 'preparing' && !status.settlementRequired)) throw new Error('Review authoring is frozen for upgrade');
  }
  refresh(): void { for (const id of this.#views.keys()) this.changed(id); }
  has(id: string): boolean { return this.#views.has(id); }
  attach(id: string, protection: ReviewProtection): void {
    if (this.#views.has(id)) return;
    this.#views.set(id, { protection, generation: protection.generation?.(), credentials: this.coordinator.registerParticipant({ id, revision: protection.revision() }) });
  }
  detach(id: string): void {
    const view = this.#views.get(id);
    if (!view) return;
    this.coordinator.unregisterParticipant(view.credentials);
    this.#views.delete(id);
  }
  changed(id: string): void {
    const view = this.#views.get(id);
    if (!view) return;
    const phase = this.coordinator.poll(view.credentials)?.phase;
    if (phase !== "committed") view.retiring = false;
    const generation = view.protection.generation?.();
    const admittedInputMayStillFlush = phase === 'preparing' && generation === view.generation;
    if (!admittedInputMayStillFlush && !view.retiring) this.coordinator.updateParticipant(view.credentials, view.protection.revision());
    view.generation = generation;
  }
  poll(id: string): UpgradeReviewStatus {
    const view = this.#views.get(id);
    if (!view) throw new Error('Upgrade review is detached');
    this.changed(id);
    const status = this.coordinator.poll(view.credentials);
    return status === undefined ? { phase: 'none' } : { phase: status.phase, attemptId: status.attemptId,
      settlementRequired: status.phase === 'preparing' && status.participants.some(p => p.id === id && !p.acknowledged),
      ...(status.reason === undefined ? {} : { reason: status.reason }) };
  }
  async settle(id: string, request: UpgradeReviewSettlement): Promise<UpgradeReviewStatus> {
    const view = this.#views.get(id);
    if (!view) throw new Error('Upgrade review is detached');
    const status = this.coordinator.poll(view.credentials);
    if (!status || status.attemptId !== request.attemptId || !['preparing', 'ready'].includes(status.phase)) throw new Error('Stale upgrade preparation');
    let durable = false;
    try {
      if (request.error !== undefined) throw new Error(request.error);
      await view.protection.protect();
      if (this.#views.get(id) !== view || this.coordinator.poll(view.credentials)?.phase !== 'preparing') throw new Error('Preparation changed while protecting review');
      for (const peer of this.#views.values()) {
        const generation = peer.protection.generation?.();
        this.coordinator.updateParticipant(peer.credentials, peer.protection.revision(), { settlement: generation === peer.generation });
        peer.generation = generation;
      }
      durable = true;
    } catch { durable = false; }
    this.coordinator.acknowledge(view.credentials, status, { revision: view.protection.revision(),
      reviewRevisionDurable: durable, protectedDraftDurable: durable, pdfSaveSettled: durable });
    return this.poll(id);
  }
}
