import { randomBytes } from "node:crypto";
import type { DaemonLifecycleCoordinator } from "./daemon-lifecycle.js";
import type { DaemonAggregateActivity } from "./control-protocol.js";

export interface UpgradeCandidate {
  readonly daemonIdentity: string;
  readonly installArtifactIdentity: string;
}
export interface UpgradeAttemptCredentials {
  readonly attemptId: string;
  readonly token: string;
  readonly candidate: UpgradeCandidate;
}
export interface UpgradeParticipantCredentials {
  readonly participantId: string;
  readonly participantToken: string;
}
export interface UpgradeAcknowledgement {
  readonly revision: string;
  readonly reviewRevisionDurable: boolean;
  readonly protectedDraftDurable: boolean;
  readonly pdfSaveSettled: boolean;
}
export type UpgradePreparationPhase = "preview" | "preparing" | "ready" | "committed" | "canceled";
export interface UpgradePreparationStatus extends UpgradeAttemptCredentials {
  readonly installedDaemonIdentity: string;
  readonly phase: UpgradePreparationPhase;
  readonly expiresAt: number;
  readonly participants: readonly { readonly id: string; readonly revision: string; readonly acknowledged: boolean }[];
  readonly activity: DaemonAggregateActivity;
  readonly reason?: string;
}
export type UpgradeParticipantStatus = Omit<UpgradePreparationStatus, "token">;
export type UpgradeParticipantAttempt = Pick<UpgradeAttemptCredentials, "attemptId" | "candidate">;
export type UpgradePreparationRequest =
  | { readonly operation: "preview"; readonly installedDaemonIdentity: string; readonly candidate: UpgradeCandidate }
  | { readonly operation: "begin"; readonly credentials: UpgradeAttemptCredentials; readonly consent: boolean }
  | { readonly operation: "status" | "cancel" | "commit"; readonly credentials: UpgradeAttemptCredentials }
  | { readonly operation: "participant-poll"; readonly participant: UpgradeParticipantCredentials }
  | { readonly operation: "participant-ack"; readonly participant: UpgradeParticipantCredentials; readonly credentials: UpgradeParticipantAttempt; readonly acknowledgement: UpgradeAcknowledgement };
export type UpgradePreparationResult = UpgradePreparationStatus | UpgradeParticipantStatus | { readonly phase: "none" };
interface Participant { id: string; revision: string; token: string }
interface Attempt { status: UpgradePreparationStatus; timer: ReturnType<typeof setTimeout> }
const secret = (): string => randomBytes(32).toString("base64url");
const sameCandidate = (a: UpgradeCandidate, b: UpgradeCandidate): boolean => a.daemonIdentity === b.daemonIdentity && a.installArtifactIdentity === b.installArtifactIdentity;

/** Only authenticated service adapters register participants. Tokens never grant
 * review authority; they authenticate settlement for the already admitted host. */
export class UpgradePreparationCoordinator {
  readonly #participants = new Map<string, Participant>();
  #attempt?: Attempt;
  #participantsCovered: () => boolean;
  constructor(readonly lifecycle: DaemonLifecycleCoordinator, readonly timeoutMs = 120_000) {
    this.#participantsCovered = () => {
      const activity = lifecycle.status().activity;
      return activity.reviewPresence === 0 && activity.codexTasks === 0;
    };
  }

  /** Trusted managers must account for every live host and task, including
   * overlapping broker/app/helper presence, before any host may close. */
  setParticipantCoverage(check: () => boolean): void { this.#participantsCovered = check; }
  #ready(status: UpgradePreparationStatus): boolean {
    return status.participants.every(p => p.acknowledged) && this.#participantsCovered();
  }

  registerParticipant(participant: { readonly id: string; readonly revision: string }): UpgradeParticipantCredentials {
    if (this.#participants.has(participant.id)) throw new Error("Upgrade participant already registered");
    this.#invalidate("A new review host joined");
    const token = secret();
    this.#participants.set(participant.id, { ...participant, token });
    return { participantId: participant.id, participantToken: token };
  }
  updateParticipant(participant: UpgradeParticipantCredentials, revision: string, options: { readonly settlement?: boolean } = {}): void {
    const current = this.#authenticate(participant);
    if (current.revision !== revision) {
      const status = this.#attempt?.status;
      if (options.settlement && status?.phase === "preparing") {
        this.#attempt!.status = { ...status, participants: status.participants.map(p => p.id === current.id ? { ...p, revision, acknowledged: false } : p) };
      } else this.#invalidate("Review revision changed");
      current.revision = revision;
    }
  }
  unregisterParticipant(participant: UpgradeParticipantCredentials): void {
    this.#authenticate(participant);
    if (this.#attempt?.status.phase !== "committed") this.#invalidate("Review host disconnected before closure was committed");
    this.#participants.delete(participant.participantId);
  }
  preview(installedDaemonIdentity: string, candidate: UpgradeCandidate): UpgradePreparationStatus {
    if (this.#attempt && this.#attempt.status.phase !== "canceled") throw new Error("Upgrade preparation already in progress");
    const status: UpgradePreparationStatus = {
      attemptId: secret(), token: secret(), candidate: { ...candidate }, installedDaemonIdentity,
      phase: "preview", expiresAt: Date.now() + this.timeoutMs,
      participants: [...this.#participants.values()].map(p => ({ id: p.id, revision: p.revision, acknowledged: false })),
      activity: this.lifecycle.status().activity,
    };
    const timer = setTimeout(() => this.#invalidate("Upgrade preparation expired"), this.timeoutMs);
    timer.unref?.();
    this.#attempt = { status, timer };
    return this.#copy(status);
  }
  begin(credentials: UpgradeAttemptCredentials, consent: boolean): UpgradePreparationStatus {
    const status = this.#validate(credentials);
    if (status.phase !== "preview") throw new Error("Upgrade preparation is not awaiting consent");
    if (!consent) return this.cancel(credentials, "User declined closing reviews");
    if (JSON.stringify(status.activity) !== JSON.stringify(this.lifecycle.status().activity)) return this.cancel(credentials, "Admitted activity changed before consent");
    this.lifecycle.freezeAdmission();
    this.#attempt!.status = { ...status, phase: this.#ready(status) ? "ready" : "preparing",
      ...(!this.#participantsCovered() ? { reason: "Active review hosts or Codex tasks have no protected preparation participant" } : {}) };
    return this.status(credentials);
  }
  acknowledge(participant: UpgradeParticipantCredentials, credentials: UpgradeParticipantAttempt, acknowledgement: UpgradeAcknowledgement): UpgradeParticipantStatus {
    const host = this.#authenticate(participant); const status = this.#validateParticipantAttempt(credentials);
    if (status.phase !== "preparing" && status.phase !== "ready") throw new Error("Upgrade preparation is not accepting acknowledgements");
    const expected = status.participants.find(p => p.id === host.id);
    if (!expected || expected.revision !== host.revision || acknowledgement.revision !== expected.revision
      || !acknowledgement.reviewRevisionDurable || !acknowledgement.protectedDraftDurable || !acknowledgement.pdfSaveSettled) {
      this.#invalidate("Review protection failed or revision acknowledgement is stale");
      return this.#participantView(this.#attempt!.status);
    }
    const participants = status.participants.map(p => p.id === host.id ? { ...p, acknowledged: true } : p);
    const { reason: _reason, ...protectedStatus } = status;
    this.#attempt!.status = { ...protectedStatus, participants, phase: this.#ready({ ...status, participants }) ? "ready" : "preparing",
      ...(!this.#participantsCovered() ? { reason: "Active review hosts or Codex tasks have no protected preparation participant" } : {}) };
    return this.#participantView(this.#attempt!.status);
  }
  commit(credentials: UpgradeAttemptCredentials): UpgradePreparationStatus {
    const status = this.#validate(credentials);
    if (status.phase !== "ready" || !this.#ready(status)) throw new Error("Upgrade preparation requires durable acknowledgements and coverage of every active host and task");
    this.lifecycle.allowPreparedShutdown();
    this.#attempt!.status = { ...status, phase: "committed" };
    return this.status(credentials);
  }
  cancel(credentials: UpgradeAttemptCredentials, reason = "Installer canceled preparation"): UpgradePreparationStatus {
    this.#validate(credentials); this.#invalidate(reason); return this.status(credentials);
  }
  status(credentials: UpgradeAttemptCredentials): UpgradePreparationStatus { return this.#copy(this.#validate(credentials)); }
  poll(participant: UpgradeParticipantCredentials): UpgradeParticipantStatus | undefined {
    this.#authenticate(participant);
    if (this.#attempt && this.#attempt.status.phase !== "canceled" && Date.now() >= this.#attempt.status.expiresAt) this.#invalidate("Upgrade preparation expired");
    const status = this.#attempt?.status;
    return status?.participants.some(p => p.id === participant.participantId) ? this.#participantView(status) : undefined;
  }
  close(): void { this.#invalidate("Service closed"); }
  #participantView(status: UpgradePreparationStatus): UpgradeParticipantStatus {
    const { token: _token, ...view } = this.#copy(status);
    return view;
  }
  #validateParticipantAttempt(credentials: UpgradeParticipantAttempt): UpgradePreparationStatus {
    const status = this.#attempt?.status;
    if (!status || status.attemptId !== credentials.attemptId || !sameCandidate(status.candidate, credentials.candidate)) throw new Error("Invalid upgrade attempt credentials");
    if (status.phase !== "canceled" && Date.now() >= status.expiresAt) this.#invalidate("Upgrade preparation expired");
    return this.#attempt!.status;
  }
  #authenticate(participant: UpgradeParticipantCredentials): Participant {
    const current = this.#participants.get(participant.participantId);
    if (!current || current.token !== participant.participantToken) throw new Error("Invalid upgrade participant credentials");
    return current;
  }
  #validate(credentials: UpgradeAttemptCredentials): UpgradePreparationStatus {
    const status = this.#attempt?.status;
    if (!status || status.attemptId !== credentials.attemptId || status.token !== credentials.token || !sameCandidate(status.candidate, credentials.candidate)) throw new Error("Invalid upgrade attempt credentials");
    if (status.phase !== "canceled" && Date.now() >= status.expiresAt) this.#invalidate("Upgrade preparation expired");
    return this.#attempt!.status;
  }
  #invalidate(reason: string): void {
    if (!this.#attempt || this.#attempt.status.phase === "canceled") return;
    clearTimeout(this.#attempt.timer);
    this.#attempt.status = { ...this.#attempt.status, phase: "canceled", reason };
    this.lifecycle.resumeAdmission();
  }
  #copy(status: UpgradePreparationStatus): UpgradePreparationStatus {
    return { ...status, candidate: { ...status.candidate }, activity: { ...status.activity }, participants: status.participants.map(p => ({ ...p })) };
  }
}

export function isUpgradePreparationRequest(value: unknown): value is UpgradePreparationRequest {
  const object = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
  const opaque = (input: unknown): input is string => typeof input === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input);
  const candidate = (input: unknown): boolean => object(input) && [input.daemonIdentity, input.installArtifactIdentity].every(x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x));
  const credentials = (input: unknown, installer = true): boolean => object(input) && opaque(input.attemptId) && (!installer || opaque(input.token)) && candidate(input.candidate);
  const participant = (input: unknown): boolean => object(input) && typeof input.participantId === "string" && input.participantId.length > 0 && input.participantId.length <= 512 && opaque(input.participantToken);
  if (!object(value)) return false;
  if (value.operation === "preview") return typeof value.installedDaemonIdentity === "string" && /^(?:development|[a-f0-9]{64})$/u.test(value.installedDaemonIdentity) && candidate(value.candidate);
  if (value.operation === "begin") return credentials(value.credentials) && typeof value.consent === "boolean";
  if (value.operation === "status" || value.operation === "cancel" || value.operation === "commit") return credentials(value.credentials);
  if (value.operation === "participant-poll") return participant(value.participant);
  if (value.operation === "participant-ack") return participant(value.participant) && credentials(value.credentials, false) && object(value.acknowledgement)
    && typeof value.acknowledgement.revision === "string" && value.acknowledgement.revision.length <= 512
    && [value.acknowledgement.reviewRevisionDurable, value.acknowledgement.protectedDraftDurable, value.acknowledgement.pdfSaveSettled].every(x => typeof x === "boolean");
  return false;
}
