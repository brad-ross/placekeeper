import type {
  DaemonAggregateActivity,
  DaemonLifecycleState,
} from "./launch-control.js";

export interface ActivityLease {
  complete(): void;
}

export type ConditionalShutdownResult =
  | { readonly status: "accepted" }
  | { readonly status: "refused"; readonly activity: DaemonAggregateActivity };

export interface DaemonLifecycleCoordinatorOptions {
  readonly activity: () => DaemonAggregateActivity;
  readonly drain: () => Promise<void>;
}

/** Serializes the small synchronous entry/commit boundary around daemon work.
 * JavaScript's run-to-completion semantics make enter/cancel and the final
 * commit atomic with respect to every route sharing this coordinator. */
export class DaemonLifecycleCoordinator {
  readonly #activity: () => DaemonAggregateActivity;
  readonly #drain: () => Promise<void>;
  #lifecycle: DaemonLifecycleState = "accepting";
  #activeRoutes = 0;
  readonly #routeSettlements = new Set<Promise<void>>();
  #frozenSettlements: readonly Promise<void>[] = [];
  #attempt = 0;
  #admissionFrozen = false;
  #preparedShutdown = false;

  constructor(options: DaemonLifecycleCoordinatorOptions) {
    this.#activity = options.activity;
    this.#drain = options.drain;
  }

  status(): { readonly lifecycle: DaemonLifecycleState; readonly activity: DaemonAggregateActivity } {
    const activity = this.#activity();
    return {
      lifecycle: this.#lifecycle,
      activity: {
        reviewPresence: activity.reviewPresence,
        codexTasks: activity.codexTasks,
        transientWork: activity.transientWork + this.#activeRoutes,
      },
    };
  }

  admissionAllowed(): boolean { return !this.#admissionFrozen && this.#lifecycle !== "shutdown-committed"; }

  freezeAdmission(): void {
    if (this.#lifecycle === "shutdown-committed") throw new Error("Service already retired");
    if (this.#lifecycle === "draining") { this.#lifecycle = "accepting"; this.#attempt += 1; }
    this.#frozenSettlements = [...this.#routeSettlements];
    this.#admissionFrozen = true;
    this.#preparedShutdown = false;
  }

  async settlementBarrier(): Promise<void> { await Promise.all(this.#frozenSettlements); }

  allowPreparedShutdown(): void { this.#preparedShutdown = true; }

  resumeAdmission(): void {
    this.#admissionFrozen = false;
    this.#preparedShutdown = false;
    if (this.#lifecycle === "draining") { this.#lifecycle = "accepting"; this.#attempt += 1; }
  }

  enterActivity(options: { readonly settlement?: boolean } = {}): ActivityLease | undefined {
    if (this.#admissionFrozen && !options.settlement) return undefined;
    if (this.#lifecycle === "shutdown-committed") return undefined;
    if (this.#lifecycle === "draining") {
      this.#lifecycle = "accepting";
      this.#attempt += 1;
    }
    this.#activeRoutes += 1;
    const completion = Promise.withResolvers<void>();
    this.#routeSettlements.add(completion.promise);
    let active = true;
    return {
      complete: () => {
        if (!active) return;
        active = false;
        this.#activeRoutes -= 1;
        this.#routeSettlements.delete(completion.promise);
        completion.resolve();
      },
    };
  }

  async runActivity<T>(work: () => T | Promise<T>, options: { readonly settlement?: boolean } = {}): Promise<T | undefined> {
    const lease = this.enterActivity(options);
    if (lease === undefined) return undefined;
    try {
      return await work();
    } finally {
      lease.complete();
    }
  }

  async shutdownIfIdle(options: { readonly authorize?: () => boolean } = {}): Promise<ConditionalShutdownResult> {
    const authorized = (): boolean => {
      try { return options.authorize?.() !== false && (!this.#admissionFrozen || (this.#preparedShutdown && options.authorize?.() === true)); }
      catch { return false; }
    };
    const before = this.status().activity;
    if (!authorized()) return { status: "refused", activity: before };
    if (this.#lifecycle === "shutdown-committed") return { status: "accepted" };
    if (!authorized() || this.#lifecycle !== "accepting" || hasNonDrainableActivity(before, this.#activeRoutes)) {
      return { status: "refused", activity: before };
    }

    this.#lifecycle = "draining";
    const attempt = ++this.#attempt;
    try { await this.#drain(); }
    catch (error) {
      if (attempt === this.#attempt) { this.#lifecycle = "accepting"; this.#attempt += 1; }
      throw error;
    }
    if (this.#lifecycle !== "draining" || attempt !== this.#attempt) {
      return { status: "refused", activity: this.status().activity };
    }

    const after = this.status().activity;
    if (!authorized() || hasAnyActivity(after)) {
      this.#lifecycle = "accepting";
      this.#attempt += 1;
      return { status: "refused", activity: after };
    }
    this.#lifecycle = "shutdown-committed";
    return { status: "accepted" };
  }
}

function hasNonDrainableActivity(activity: DaemonAggregateActivity, activeRoutes: number): boolean {
  return activity.reviewPresence > 0 || activity.codexTasks > 0 || activeRoutes > 0;
}

function hasAnyActivity(activity: DaemonAggregateActivity): boolean {
  return activity.reviewPresence > 0 || activity.codexTasks > 0 || activity.transientWork > 0;
}
