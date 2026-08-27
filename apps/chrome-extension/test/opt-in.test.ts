import { describe, expect, it, vi } from "vitest";
import {
  initializeFreshInstall,
  readAutoOpenState,
  setAutoOpenEnabled,
  type AutoOpenPorts,
} from "../src/opt-in.js";

function ports(initialSentinel?: boolean, initialMimeEnabled = true): AutoOpenPorts & {
  sentinel: () => boolean | undefined;
  mimeEnabled: () => boolean;
} {
  let sentinel = initialSentinel;
  let mimeEnabled = initialMimeEnabled;
  return {
    readSentinel: async () => sentinel,
    writeSentinel: vi.fn(async (value) => {
      sentinel = value;
    }),
    readMimeEnabled: async () => mimeEnabled,
    writeMimeEnabled: vi.fn(async (value) => {
      mimeEnabled = value;
    }),
    sentinel: () => sentinel,
    mimeEnabled: () => mimeEnabled,
  };
}

describe("automatic-open opt-in", () => {
  it("initializes a fresh install paused even though Chrome defaults the handler on", async () => {
    const state = ports(undefined, true);

    await initializeFreshInstall(state);

    expect(state.sentinel()).toBe(false);
    expect(state.mimeEnabled()).toBe(false);
    await expect(readAutoOpenState(state)).resolves.toEqual({ enabled: false, synchronized: true });
  });

  it("requires both the opt-in sentinel and browser MIME option", async () => {
    await expect(readAutoOpenState(ports(undefined, true))).resolves.toEqual({
      enabled: false,
      synchronized: false,
    });
    await expect(readAutoOpenState(ports(true, false))).resolves.toEqual({
      enabled: false,
      synchronized: false,
    });
  });

  it("enables and pauses through synchronized browser-owned state", async () => {
    const state = ports(false, false);

    await setAutoOpenEnabled(state, true);
    expect(state.sentinel()).toBe(true);
    expect(state.mimeEnabled()).toBe(true);

    await setAutoOpenEnabled(state, false);
    expect(state.sentinel()).toBe(false);
    expect(state.mimeEnabled()).toBe(false);
  });

  it("rolls back the sentinel if enabling the MIME handler fails", async () => {
    const state = ports(false, false);
    state.writeMimeEnabled = vi.fn(async () => {
      throw new Error("Chrome rejected the setting");
    });

    await expect(setAutoOpenEnabled(state, true)).rejects.toThrow("Chrome rejected the setting");
    expect(state.sentinel()).toBe(false);
  });
});
