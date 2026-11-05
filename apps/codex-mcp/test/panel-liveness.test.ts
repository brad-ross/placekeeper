import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeDiagnosticError } from "../src/lifecycle-diagnostics.js";
import { PanelLiveness } from "../src/panel-liveness.js";

const transportError = () => new NativeDiagnosticError("transport");
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<ConstructorParameters<typeof PanelLiveness>[0]> = {}) {
  const options = {
    renew: vi.fn(async () => undefined),
    poll: vi.fn(async () => undefined),
    pollInterval: () => 1_000,
    onState: vi.fn(),
    onTerminal: vi.fn(),
    ...overrides,
  };
  return { ...options, connection: new PanelLiveness(options) };
}
afterEach(() => { vi.useRealTimers(); });

describe("authenticated panel liveness", () => {
  it("renews and refreshes independently, and stops all scheduled work on disposal", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.connection.start(); await tick();
    expect(f.renew).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1);
    await tick(5_000);
    expect(f.renew).toHaveBeenCalledTimes(2); expect(f.poll).toHaveBeenCalledTimes(6);
    f.connection.stop(); await tick(30_000);
    expect(f.renew).toHaveBeenCalledTimes(2); expect(f.poll).toHaveBeenCalledTimes(6);
  });

  it("keeps a transiently interrupted panel suspended until both probes verify it again", async () => {
    vi.useFakeTimers();
    const renewal = deferred();
    const f = fixture({ renew: vi.fn().mockRejectedValueOnce(transportError()).mockImplementation(() => renewal.promise) });
    f.connection.start(); await tick();
    expect(f.onState).toHaveBeenLastCalledWith("reconnecting");
    await tick(1_000);
    expect(f.onTerminal).not.toHaveBeenCalled();
    expect(f.onState).not.toHaveBeenCalledWith("connected");
    renewal.resolve(); await tick();
    expect(f.onState).toHaveBeenLastCalledWith("connected");
    f.connection.stop();
  });

  it("does not count a reply started before interruption as refreshed state", async () => {
    vi.useFakeTimers();
    const stalePoll = deferred();
    const f = fixture({
      renew: vi.fn().mockRejectedValueOnce(transportError()).mockResolvedValue(undefined),
      poll: vi.fn().mockImplementationOnce(() => stalePoll.promise).mockResolvedValue(undefined),
    });
    f.connection.start(); await tick(1_000);
    stalePoll.resolve(); await tick();
    expect(f.onState).not.toHaveBeenCalledWith("connected");
    await tick(1_000);
    expect(f.onState).toHaveBeenLastCalledWith("connected");
    f.connection.stop();
  });

  it("fails closed on a definitive denial without retrying it", async () => {
    vi.useFakeTimers();
    const denied = new NativeDiagnosticError("service-denied-revoked");
    const f = fixture({ renew: vi.fn().mockRejectedValue(denied) });
    f.connection.start(); await tick(60_000);
    expect(f.onTerminal).toHaveBeenCalledExactlyOnceWith(denied);
    expect(f.renew).toHaveBeenCalledTimes(1);
    expect(f.onState).not.toHaveBeenCalledWith("reconnecting");
  });

  it("bounds retries during a continuing outage instead of retaining live authority indefinitely", async () => {
    vi.useFakeTimers();
    const f = fixture({ renew: vi.fn().mockRejectedValue(transportError()) });
    f.connection.start(); await tick(20_000);
    expect(f.onTerminal).toHaveBeenCalledTimes(1);
    const attempts = vi.mocked(f.renew).mock.calls.length;
    expect(attempts).toBeGreaterThan(1); expect(attempts).toBeLessThan(10);
    await tick(60_000);
    expect(f.renew).toHaveBeenCalledTimes(attempts);
  });

  it("coalesces wake events during requests and immediately probes again without overlapping calls", async () => {
    vi.useFakeTimers();
    const renewal = deferred(), poll = deferred();
    const f = fixture({
      renew: vi.fn().mockImplementationOnce(() => renewal.promise).mockResolvedValue(undefined),
      poll: vi.fn().mockImplementationOnce(() => poll.promise).mockResolvedValue(undefined),
    });
    f.connection.start();
    f.connection.wake(); f.connection.wake(); f.connection.wake();
    expect(f.renew).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1);
    renewal.resolve(); poll.resolve(); await tick();
    expect(f.renew).toHaveBeenCalledTimes(2); expect(f.poll).toHaveBeenCalledTimes(2);
    f.connection.stop();
  });

  it("ignores completions from a stopped panel and does not reopen it on wake", async () => {
    vi.useFakeTimers();
    const renewal = deferred();
    const f = fixture({ renew: () => renewal.promise });
    f.connection.start(); f.connection.stop(); f.connection.wake();
    renewal.resolve(); await tick(60_000);
    expect(f.onState).not.toHaveBeenCalled(); expect(f.onTerminal).not.toHaveBeenCalled();
    expect(f.poll).toHaveBeenCalledTimes(1);
  });

  it("retries obsolete-generation races without reporting a lost connection", async () => {
    vi.useFakeTimers();
    const error = new Error("obsolete generation"); error.name = "AbortError";
    const f = fixture({ renew: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined) });
    f.connection.start(); await tick(5_000);
    expect(f.renew).toHaveBeenCalledTimes(2);
    expect(f.onState).not.toHaveBeenCalled(); expect(f.onTerminal).not.toHaveBeenCalled();
    f.connection.stop();
  });
});
