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
  #attempt = 0;

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

  enterActivity(): ActivityLease | undefined {
    if (this.#lifecycle === "shutdown-committed") return undefined;
    if (this.#lifecycle === "draining") {
      this.#lifecycle = "accepting";
      this.#attempt += 1;
    }
    this.#activeRoutes += 1;
    let active = true;
    return {
      complete: () => {
        if (!active) return;
        active = false;
        this.#activeRoutes -= 1;
      },
    };
  }

  async runActivity<T>(work: () => T | Promise<T>): Promise<T | undefined> {
    const lease = this.enterActivity();
    if (lease === undefined) return undefined;
    try {
      return await work();
    } finally {
      lease.complete();
    }
  }

  async shutdownIfIdle(): Promise<ConditionalShutdownResult> {
    if (this.#lifecycle === "shutdown-committed") return { status: "accepted" };
    const before = this.status().activity;
    if (this.#lifecycle !== "accepting" || hasNonDrainableActivity(before, this.#activeRoutes)) {
      return { status: "refused", activity: before };
    }

    this.#lifecycle = "draining";
    const attempt = ++this.#attempt;
    await this.#drain();
    if (this.#lifecycle !== "draining" || attempt !== this.#attempt) {
      return { status: "refused", activity: this.status().activity };
    }

    const after = this.status().activity;
    if (hasAnyActivity(after)) {
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
