import { diagnosticFailure } from "./lifecycle-diagnostics.js";

type Probe = "renew" | "poll";
export type PanelConnectionState = "connected" | "reconnecting";
interface ProbeState {
  timer?: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  wake: boolean;
  failures: number;
  verified: boolean;
}
interface PanelLivenessOptions {
  renew(): Promise<void>;
  poll(): Promise<void>;
  pollInterval(): number;
  onState(state: PanelConnectionState): void;
  onTerminal(error: unknown): void;
}

/** Only idempotent liveness probes retry. User operations keep their own receipts. */
export class PanelLiveness {
  readonly #options: PanelLivenessOptions;
  readonly #probes: Record<Probe, ProbeState> = {
    renew: { running: false, wake: false, failures: 0, verified: false },
    poll: { running: false, wake: false, failures: 0, verified: false },
  };
  #active = false;
  #started = false;
  #epoch = 0;
  #interruptedAt: number | undefined;

  constructor(options: PanelLivenessOptions) { this.#options = options; }

  start(): void {
    if (this.#started) return;
    this.#started = true; this.#active = true;
    void this.#run("renew"); void this.#run("poll");
  }

  stop(): void {
    this.#active = false;
    for (const probe of Object.values(this.#probes)) {
      if (probe.timer !== undefined) clearTimeout(probe.timer);
      probe.timer = undefined; probe.wake = false;
    }
  }

  wake(): void {
    if (!this.#active) return;
    for (const name of ["renew", "poll"] as const) {
      const probe = this.#probes[name];
      if (probe.timer !== undefined) clearTimeout(probe.timer);
      probe.timer = undefined;
      if (probe.running) probe.wake = true;
      else void this.#run(name);
    }
  }

  async #run(name: Probe): Promise<void> {
    const probe = this.#probes[name];
    if (!this.#active || probe.running) return;
    probe.running = true;
    const epoch = this.#epoch;
    let delay = name === "renew" ? 5_000 : this.#options.pollInterval();
    try {
      await this.#options[name]();
      if (!this.#active) return;
      probe.failures = 0;
      if (epoch === this.#epoch) probe.verified = true;
      if (this.#interruptedAt !== undefined && this.#probes.renew.verified && this.#probes.poll.verified) {
        this.#interruptedAt = undefined;
        this.#options.onState("connected");
      }
    } catch (error) {
      if (!this.#active) return;
      if (error instanceof Error && error.name === "AbortError") {
        // A generation change invalidated a concurrent reply. The next probe
        // uses the successor capability; this is not a transport interruption.
      } else if (diagnosticFailure(error) === "transport") {
        const now = Date.now();
        if (this.#interruptedAt === undefined) {
          this.#interruptedAt = now; this.#epoch++;
          this.#probes.renew.verified = false; this.#probes.poll.verified = false;
          this.#options.onState("reconnecting");
        }
        const remaining = 20_000 - (now - this.#interruptedAt);
        if (remaining <= 0) { this.stop(); this.#options.onTerminal(error); return; }
        probe.verified = false;
        delay = Math.min(1_000 * 2 ** Math.min(probe.failures++, 3), 5_000, remaining);
      } else {
        this.stop(); this.#options.onTerminal(error); return;
      }
    } finally {
      probe.running = false;
      if (this.#active) {
        if (probe.wake) { delay = 0; probe.wake = false; }
        probe.timer = setTimeout(() => { probe.timer = undefined; void this.#run(name); }, delay);
      }
    }
  }
}
