import { randomBytes } from "node:crypto";
import type { PlacekeeperLinkLocation } from "../../../../packages/core/src/placekeeper-link.js";
import { digestSecretHex } from "../../../../packages/core/src/session-security.js";
import type { SessionBroker } from "../sessions/session-broker.js";

type AdmissionScope = NonNullable<ReturnType<SessionBroker["nativeAdmissionScope"]>>;
export interface NativeTaskLaunchStage {
  readonly sessionId: string;
  readonly kind: "opened" | "focused";
  readonly requestedLocation?: PlacekeeperLinkLocation;
}
export interface NativeTaskLaunchReceipt {
  readonly ok: true;
  readonly kind: "opened" | "focused";
  readonly surface: "electron";
  readonly native: true;
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly bindProof: string;
  readonly launchId: string;
  readonly expiresAt: string;
}
export interface NativeTaskLaunchClaim {
  readonly bindProof: string;
  readonly taskSessionId: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
}
/** Service-private reservation. Neither this identity nor its path enters renderer projections. */
export interface NativeTaskLaunchAdmission {
  readonly id: string;
  readonly sourcePath: string;
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly location?: PlacekeeperLinkLocation;
}
interface Launch {
  scope: AdmissionScope;
  readonly bindProof: string;
  readonly admissionKey: string;
  readonly expiresAtMs: number;
  readonly location?: PlacekeeperLinkLocation;
  admission?: NativeTaskLaunchAdmission;
  owner?: string;
  visibleAttempt?: () => boolean;
  active: boolean;
}
export interface NativeTaskLaunchOptions {
  readonly now?: () => Date;
  readonly pendingTtlMs?: number;
}
const secret = () => randomBytes(32).toString("base64url");

/** Joins the trusted task claim and current native visible attempt in either arrival order. */
export class NativeTaskLaunchRegistry {
  readonly #broker: SessionBroker;
  #closed = false;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #launches = new Map<string, Launch>();
  readonly #admissions = new Map<string, Launch>();
  readonly #unsubscribeState: () => void;
  readonly #unsubscribeEnd: () => void;

  constructor(broker: SessionBroker, options: NativeTaskLaunchOptions = {}) {
    this.#broker = broker;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.pendingTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new RangeError("Invalid native launch lifetime");
    this.#unsubscribeEnd = broker.onSessionEnd((sessionId) => {
      for (const launch of [...this.#launches.values()]) if (launch.scope.reviewSessionId === sessionId) this.#remove(launch);
    });
    this.#unsubscribeState = broker.onStateInvalidation((event) => {
      if (event.reason !== "generation" && event.reason !== "save") return;
      const successor = broker.nativeAdmissionScope(event.sessionId);
      for (const launch of [...this.#launches.values()]) {
        if (launch.scope.reviewSessionId !== event.sessionId) continue;
        if (event.reason === "generation") {
          // Canonical migration may preserve an already active task association;
          // a pending launch never borrows visibility from a predecessor PDF.
          if (launch.active && successor !== undefined && launch.owner !== undefined &&
            broker.taskBindings.hasPresentationAuthority({ ...successor, taskSessionId: launch.owner,
              browserCapabilityHash: digestSecretHex(launch.admissionKey) })) launch.scope = successor;
          else this.#remove(launch);
        } else if (successor !== undefined && successor.documentGeneration === launch.scope.documentGeneration &&
          successor.sourceDigest === launch.scope.sourceDigest) launch.scope = successor;
      }
    });
  }

  stageLaunch(input: NativeTaskLaunchStage): NativeTaskLaunchReceipt | undefined {
    this.#sweep();
    if (this.#closed) return undefined;
    const scope = this.#broker.nativeAdmissionScope(input.sessionId);
    if (scope === undefined) return undefined;
    const launchId = secret();
    const admissionKey = secret();
    const bindProof = this.#broker.taskBindings.issueBindProof({ ...scope, browserCapability: admissionKey, native: true });
    const expiresAtMs = this.#now().getTime() + this.#ttlMs;
    this.#launches.set(digestSecretHex(launchId), { scope, admissionKey, bindProof, expiresAtMs, active: false,
      ...(input.requestedLocation === undefined ? {} : { location: input.requestedLocation }) });
    return { ok: true, kind: input.kind, surface: "electron", native: true, sessionId: scope.reviewSessionId,
      documentGeneration: scope.documentGeneration, bindProof, launchId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  resolveLaunch(launchId: string): { readonly sourcePath: string; readonly sessionId: string; readonly documentGeneration: number } | undefined {
    this.#sweep();
    const launch = this.#launches.get(digestSecretHex(launchId));
    if (launch === undefined || launch.admission !== undefined) return undefined;
    return { sourcePath: launch.scope.canonicalSourcePath, sessionId: launch.scope.reviewSessionId,
      documentGeneration: launch.scope.documentGeneration };
  }

  reserve(launchId: string): NativeTaskLaunchAdmission | undefined {
    this.#sweep();
    const launch = this.#launches.get(digestSecretHex(launchId));
    if (launch === undefined || launch.admission !== undefined) return undefined;
    const admission: NativeTaskLaunchAdmission = { id: secret(), sourcePath: launch.scope.canonicalSourcePath,
      sessionId: launch.scope.reviewSessionId, documentGeneration: launch.scope.documentGeneration,
      ...(launch.location === undefined ? {} : { location: launch.location }) };
    launch.admission = admission;
    this.#admissions.set(admission.id, launch);
    return admission;
  }

  matches(admission: NativeTaskLaunchAdmission, sessionId: string, generation: number): boolean {
    this.#sweep();
    const launch = this.#admissions.get(admission.id);
    return launch?.admission === admission && launch.scope.reviewSessionId === sessionId &&
      launch.scope.documentGeneration === generation;
  }

  matchesActivation(admission: NativeTaskLaunchAdmission, launchId: string | undefined): boolean {
    if (launchId === undefined) return false;
    this.#sweep();
    return this.#launches.get(digestSecretHex(launchId))?.admission === admission;
  }

  claimLaunch(input: NativeTaskLaunchClaim): boolean {
    this.#sweep();
    const launch = [...this.#launches.values()].find((candidate) => candidate.bindProof === input.bindProof);
    if (launch === undefined || launch.owner !== undefined) return false;
    if (!this.#current(launch) || (launch.visibleAttempt !== undefined && !launch.visibleAttempt())) {
      this.#remove(launch); return false;
    }
    const claimed = this.#broker.taskBindings.claimNative(input);
    if (claimed.status !== "pending") { this.#remove(launch); return false; }
    launch.owner = input.taskSessionId;
    if (launch.visibleAttempt !== undefined && !this.#promote(launch)) { this.#remove(launch); return false; }
    return true;
  }

  visible(admission: NativeTaskLaunchAdmission, currentAttempt: () => boolean): boolean {
    this.#sweep();
    const launch = this.#admissions.get(admission.id);
    if (launch?.admission !== admission || !this.#current(launch) || !currentAttempt()) return false;
    launch.visibleAttempt = currentAttempt;
    if (launch.owner !== undefined && !this.#promote(launch)) { this.#remove(launch); return false; }
    return true;
  }

  renew(admission: NativeTaskLaunchAdmission): void {
    this.#sweep();
    const launch = this.#admissions.get(admission.id);
    if (launch?.active && launch.visibleAttempt?.() && launch.owner !== undefined && this.#authorized(launch)) {
      this.#broker.taskBindings.renew({ ...launch.scope, taskSessionId: launch.owner });
    }
  }

  detach(admission: NativeTaskLaunchAdmission): void {
    const launch = this.#admissions.get(admission.id);
    if (launch?.admission === admission) this.#remove(launch);
  }

  cancelLaunch(launchId: string): boolean {
    const launch = this.#launches.get(digestSecretHex(launchId));
    if (launch === undefined || launch.active) return false;
    this.#remove(launch); return true;
  }

  close(): void {
    this.#closed = true;
    for (const launch of [...this.#launches.values()]) this.#remove(launch);
    this.#unsubscribeState();
    this.#unsubscribeEnd();
  }

  #promote(launch: Launch): boolean {
    if (launch.owner === undefined || !launch.visibleAttempt?.() || !this.#current(launch)) return false;
    const binding = { ...launch.scope, taskSessionId: launch.owner, browserCapabilityHash: digestSecretHex(launch.admissionKey) };
    if (launch.active) return this.#broker.taskBindings.hasPresentationAuthority(binding);
    if (!this.#broker.taskBindings.nativeClaimMatches(binding)) return false;
    launch.active = this.#broker.taskBindings.activateNative(binding).status === "active";
    return launch.active;
  }

  #authorized(launch: Launch): boolean {
    return launch.owner !== undefined && this.#broker.taskBindings.hasPresentationAuthority({ ...launch.scope,
      taskSessionId: launch.owner, browserCapabilityHash: digestSecretHex(launch.admissionKey) });
  }

  #current(launch: Launch): boolean {
    const live = this.#broker.nativeAdmissionScope(launch.scope.reviewSessionId);
    return live !== undefined && live.documentGeneration === launch.scope.documentGeneration &&
      live.sourceDigest === launch.scope.sourceDigest && live.canonicalSourcePath === launch.scope.canonicalSourcePath;
  }

  #remove(launch: Launch): void {
    this.#broker.taskBindings.detachPresentation(digestSecretHex(launch.admissionKey));
    if (launch.admission !== undefined) this.#admissions.delete(launch.admission.id);
    for (const [key, value] of this.#launches) if (value === launch) this.#launches.delete(key);
  }

  #sweep(): void {
    for (const launch of [...this.#launches.values()]) {
      if (!this.#current(launch) || (!launch.active && launch.expiresAtMs <= this.#now().getTime()) ||
        (launch.visibleAttempt !== undefined && !launch.visibleAttempt()) || (launch.active && !this.#authorized(launch))) this.#remove(launch);
    }
  }
}
