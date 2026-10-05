import { describe, expect, it } from "vitest";

import type { LiveObservationIdentity } from "../../../packages/core/src/live-context.js";
import { digestSecretHex } from "../../../packages/core/src/session-security.js";
import { TaskBindingRegistry } from "../src/context/task-binding-registry.js";

const BROWSER_CAPABILITY = "browser-capability-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function registryFixture() {
  let now = 1_000;
  const registry = new TaskBindingRegistry({
    now: () => new Date(now),
    pendingTtlMs: 100,
    activeLeaseTtlMs: 1_000,
  });
  return {
    registry,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function issue(registry: TaskBindingRegistry, overrides: Partial<{
  reviewSessionId: string;
  documentGeneration: number;
  browserCapability: string;
}> = {}): string {
  return registry.issueBindProof({
    reviewSessionId: "review-a",
    documentGeneration: 1,
    browserCapability: BROWSER_CAPABILITY,
    ...overrides,
  });
}

function verifiedIdentity(overrides: Partial<LiveObservationIdentity> = {}): LiveObservationIdentity {
  return {
    placekeeperSessionId: "review-a",
    documentGeneration: 1,
    source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 12 },
    reviewRevision: 4,
    stateDigest: "b".repeat(64),
    ...overrides,
  };
}

describe("task-scoped PDF binding registry", () => {
  it("requires a one-time hook claim followed by the matching browser activation", () => {
    const { registry } = registryFixture();
    const bindProof = issue(registry);
    expect(registry.activityCount()).toBe(1);

    expect(registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toMatchObject({ status: "pending" });
    expect(registry.activityCount()).toBe(1);
    expect(registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toEqual({ status: "denied" });

    expect(registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: "wrong-browser-capability-aaaaaaaaaaaaaaaaaaaaaa",
    })).toEqual({ status: "ignored" });
    expect(registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    })).toMatchObject({ status: "active" });
    expect(registry.activityCount()).toBe(1);
    expect(registry.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.revokeTask("task-a");
    expect(registry.activityCount()).toBe(0);
  });

  it("reattaches only an authenticated successor browser to the exact task", () => {
    const { registry } = registryFixture();
    const successorCapabilityHash = digestSecretHex("successor-browser-capability");

    expect(registry.attachReconnectedBrowser({
      taskSessionId: "task-a",
      reviewSessionId: "review-successor",
      documentGeneration: 2,
      browserCapabilityHash: successorCapabilityHash,
    })).toMatchObject({ status: "active" });
    expect(registry.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: "review-successor",
      documentGeneration: 2,
    });

    expect(registry.attachReconnectedBrowser({
      taskSessionId: "task-b",
      reviewSessionId: "review-successor",
      documentGeneration: 2,
      browserCapabilityHash: successorCapabilityHash,
    })).toEqual({ status: "denied" });
    expect(registry.attachReconnectedBrowser({
      taskSessionId: "task-a",
      reviewSessionId: "other-review",
      documentGeneration: 2,
      browserCapabilityHash: successorCapabilityHash,
    })).toEqual({ status: "denied" });
  });

  it("fails closed for wrong review and generation and for browser-first launch", () => {
    const { registry } = registryFixture();
    const wrongReview = issue(registry);
    expect(registry.claim({
      bindProof: wrongReview,
      taskSessionId: "task-a",
      reviewSessionId: "review-b",
      documentGeneration: 1,
    })).toEqual({ status: "denied" });

    const wrongGeneration = issue(registry, { browserCapability: `${BROWSER_CAPABILITY}-2` });
    expect(registry.claim({
      bindProof: wrongGeneration,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 2,
    })).toEqual({ status: "denied" });

    const browserFirstCapability = `${BROWSER_CAPABILITY}-3`;
    const browserFirst = issue(registry, { browserCapability: browserFirstCapability });
    expect(registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: browserFirstCapability,
    })).toEqual({ status: "ignored" });
    expect(registry.claim({
      bindProof: browserFirst,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toEqual({ status: "denied" });
  });

  it("renews the same task but denies another task without owner metadata", () => {
    const { registry, advance } = registryFixture();
    const bindProof = issue(registry);
    registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    });
    const firstExpiry = registry.bindingForTask("task-a")?.leaseExpiresAt;

    advance(200);
    expect(registry.renew({
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toMatchObject({ status: "active" });
    expect(registry.bindingForTask("task-a")?.leaseExpiresAt).not.toBe(firstExpiry);

    const foreignProof = issue(registry, { browserCapability: `${BROWSER_CAPABILITY}-foreign` });
    expect(registry.claim({
      bindProof: foreignProof,
      taskSessionId: "task-b",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toEqual({ status: "denied" });
    expect(JSON.stringify(registry.claim({
      bindProof: foreignProof,
      taskSessionId: "task-b",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    }))).not.toContain("task-a");

    const otherReviewProof = issue(registry, {
      reviewSessionId: "review-b",
      browserCapability: `${BROWSER_CAPABILITY}-other-review`,
    });
    expect(registry.claim({
      bindProof: otherReviewProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-b",
      documentGeneration: 1,
    })).toEqual({ status: "denied" });
  });

  it("keeps every claimed browser view for the same active task bound", () => {
    const { registry } = registryFixture();
    const firstProof = issue(registry);
    expect(registry.claim({
      bindProof: firstProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toMatchObject({ status: "pending" });
    expect(registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    })).toMatchObject({ status: "active" });

    const secondCapability = `${BROWSER_CAPABILITY}-second-view`;
    const secondProof = issue(registry, { browserCapability: secondCapability });
    expect(registry.claim({
      bindProof: secondProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toMatchObject({ status: "active" });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: secondCapability,
    });

    for (const capability of [BROWSER_CAPABILITY, secondCapability]) {
      expect(registry.statusForReview("review-a", {
        documentGeneration: 1,
        reviewRevision: 0,
        sourceDigest: "a".repeat(64),
        stateDigest: "b".repeat(64),
      }, digestSecretHex(capability))).toMatchObject({ status: "refreshing" });
      expect(registry.renewBrowserHeartbeat({
        reviewSessionId: "review-a",
        documentGeneration: 1,
        browserCapabilityHash: digestSecretHex(capability),
      })).toMatchObject({ status: "active" });
    }
  });

  it("renews an exact active review from an authenticated browser heartbeat without a task id", () => {
    const { registry, advance } = registryFixture();
    const bindProof = issue(registry);
    registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    });
    const originalExpiry = registry.bindingForTask("task-a")?.leaseExpiresAt;

    advance(200);
    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-a",
      documentGeneration: 2,
      browserCapabilityHash: digestSecretHex(BROWSER_CAPABILITY),
    })).toEqual({ status: "ignored" });
    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-b",
      documentGeneration: 1,
      browserCapabilityHash: digestSecretHex(BROWSER_CAPABILITY),
    })).toEqual({ status: "ignored" });
    expect(registry.bindingForTask("task-a")?.leaseExpiresAt).toBe(originalExpiry);

    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapabilityHash: digestSecretHex(BROWSER_CAPABILITY),
    })).toMatchObject({ status: "active" });
    expect(registry.bindingForTask("task-a")?.leaseExpiresAt).not.toBe(originalExpiry);

    registry.revokeTask("task-a");
    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapabilityHash: digestSecretHex(BROWSER_CAPABILITY),
    })).toEqual({ status: "ignored" });
  });

  it("requires the activating browser capability discriminator for heartbeat and status", () => {
    const { registry, advance } = registryFixture();
    const bindProof = issue(registry);
    registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    });
    const originalExpiry = registry.bindingForTask("task-a")?.leaseExpiresAt;
    const activeDiscriminator = digestSecretHex(BROWSER_CAPABILITY);
    const otherDiscriminator = digestSecretHex(`${BROWSER_CAPABILITY}-other-view`);

    advance(200);
    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapabilityHash: otherDiscriminator,
    })).toEqual({ status: "ignored" });
    expect(registry.bindingForTask("task-a")?.leaseExpiresAt).toBe(originalExpiry);
    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 0,
      sourceDigest: "a".repeat(64),
      stateDigest: "b".repeat(64),
    }, otherDiscriminator)).toEqual({ status: "unbound" });

    expect(registry.renewBrowserHeartbeat({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapabilityHash: activeDiscriminator,
    })).toMatchObject({ status: "active" });
    expect(registry.bindingForTask("task-a")?.leaseExpiresAt).not.toBe(originalExpiry);
    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 0,
      sourceDigest: "a".repeat(64),
      stateDigest: "b".repeat(64),
    }, activeDiscriminator)).toMatchObject({ status: "refreshing" });
  });

  it("reports current only while the verified identity matches live review state", () => {
    const { registry } = registryFixture();
    const bindProof = issue(registry);
    registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    });
    const verified = verifiedIdentity();
    expect(registry.markVerified("task-a", verified)).toBe(true);

    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 4,
      sourceDigest: "a".repeat(64),
      stateDigest: verified.stateDigest,
    }, digestSecretHex(BROWSER_CAPABILITY))).toMatchObject({ status: "current", identity: verified });
    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 4,
      sourceDigest: "a".repeat(64),
      stateDigest: "d".repeat(64),
    }, digestSecretHex(BROWSER_CAPABILITY))).toMatchObject({ status: "refreshing", lastVerified: verified });
    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 5,
      sourceDigest: "a".repeat(64),
      stateDigest: verified.stateDigest,
    }, digestSecretHex(BROWSER_CAPABILITY))).toMatchObject({ status: "refreshing", lastVerified: verified });
    expect(registry.statusForReview("review-a", {
      documentGeneration: 1,
      reviewRevision: 4,
      sourceDigest: "c".repeat(64),
      stateDigest: verified.stateDigest,
    }, digestSecretHex(BROWSER_CAPABILITY))).toMatchObject({ status: "refreshing", lastVerified: verified });
    expect(registry.statusForReview("review-a", {
      documentGeneration: 2,
      reviewRevision: 4,
      sourceDigest: "a".repeat(64),
      stateDigest: verified.stateDigest,
    }, digestSecretHex(BROWSER_CAPABILITY))).toEqual({ status: "unbound" });
  });

  it("migrates only the exact active lease and clears predecessor verification", () => {
    const { registry } = registryFixture();
    const bindProof = issue(registry);
    registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: BROWSER_CAPABILITY,
    });
    expect(registry.markVerified("task-a", verifiedIdentity())).toBe(true);

    expect(registry.migrateGeneration({
      reviewSessionId: "review-a",
      previousGeneration: 1,
      successorGeneration: 2,
    })).toEqual({ status: "migrated", taskSessionId: "task-a" });
    expect(registry.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: "review-a",
      documentGeneration: 2,
    });
    expect(registry.bindingForTask("task-a")?.lastVerified).toBeUndefined();
    expect(registry.taskForGeneration("review-a", 1)).toBeUndefined();
    expect(registry.taskForGeneration("review-a", 2)).toBe("task-a");

    expect(registry.migrateGeneration({
      reviewSessionId: "review-a",
      previousGeneration: 1,
      successorGeneration: 3,
    })).toEqual({ status: "revoked" });
    expect(registry.bindingForTask("task-a")).toBeUndefined();
  });

  it("expires pending claims and active leases and supports explicit lifecycle revocation", () => {
    const { registry, advance } = registryFixture();
    const pendingProof = issue(registry);
    registry.claim({
      bindProof: pendingProof,
      taskSessionId: "task-pending",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    expect(registry.unavailableReasonForTask("task-pending")).toBe("pending");
    advance(101);
    expect(registry.bindingForTask("task-pending")).toBeUndefined();
    expect(registry.unavailableReasonForTask("task-pending")).toBe("expired");

    const activeCapability = `${BROWSER_CAPABILITY}-active`;
    const activeProof = issue(registry, { browserCapability: activeCapability });
    registry.claim({
      bindProof: activeProof,
      taskSessionId: "task-active",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: activeCapability,
    });
    advance(1_001);
    expect(registry.bindingForTask("task-active")).toBeUndefined();
    expect(registry.unavailableReasonForTask("task-active")).toBe("expired");

    const revokeCapability = `${BROWSER_CAPABILITY}-revoke`;
    const revokeProof = issue(registry, { browserCapability: revokeCapability });
    registry.claim({
      bindProof: revokeProof,
      taskSessionId: "task-revoke",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.activateBrowser({
      reviewSessionId: "review-a",
      documentGeneration: 1,
      browserCapability: revokeCapability,
    });
    registry.revokeTask("task-revoke");
    expect(registry.bindingForTask("task-revoke")).toBeUndefined();
    expect(registry.unavailableReasonForTask("task-revoke")).toBe("unbound");

    const generationCapability = `${BROWSER_CAPABILITY}-generation`;
    const generationProof = issue(registry, { browserCapability: generationCapability });
    registry.claim({
      bindProof: generationProof,
      taskSessionId: "task-generation",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    registry.revokeGeneration("review-a", 2);
    expect(registry.bindingForTask("task-generation")).toBeUndefined();
  });
});

describe("native reservations preserve browser behavior", () => {
  it("keeps native proofs out of browser auto-add and reserves exclusive ownership until activation", () => {
    const { registry } = registryFixture();
    const input = { taskSessionId: "task-a", reviewSessionId: "review-a", documentGeneration: 1 };
    const capability = "native-private-capability";
    const proof = registry.issueBindProof({ ...input, browserCapability: capability, native: true });
    expect(registry.claim({ ...input, bindProof: proof })).toEqual({ status: "denied" });
    expect(registry.claimNative({ ...input, bindProof: proof }).status).toBe("pending");
    const browser = registry.issueBindProof({ reviewSessionId: "review-a", documentGeneration: 1, browserCapability: "browser-peer" });
    expect(registry.claim({ ...input, taskSessionId: "task-b", bindProof: browser })).toEqual({ status: "denied" });
    expect(registry.bindingForTask("task-a")).toBeUndefined();
    expect(registry.activateNative({ ...input, browserCapabilityHash: digestSecretHex(capability) }).status).toBe("active");
    const peer = registry.issueBindProof({ ...input, browserCapability: "native-peer", native: true });
    expect(registry.claimNative({ ...input, bindProof: peer }).status).toBe("pending");
    expect(registry.hasPresentationAuthority({ ...input, browserCapabilityHash: digestSecretHex("native-peer") })).toBe(false);
    registry.revokeTask("task-a");
    expect(registry.activateNative({ ...input, browserCapabilityHash: digestSecretHex("native-peer") })).toEqual({ status: "denied" });
  });
});

describe("same-association browser/native admission coexistence", () => {
  it.each([
    ["native-first", "native-first"],
    ["native-first", "browser-first"],
    ["browser-first", "native-first"],
    ["browser-first", "browser-first"],
  ])("preserves both memberships with %s claim and %s activation", (claimOrder, activationOrder) => {
    const { registry } = registryFixture();
    const binding = { taskSessionId: "task-a", reviewSessionId: "review-a", documentGeneration: 1 };
    const nativeScope = { ...binding, browserCapabilityHash: digestSecretHex("native-panel") };
    const native = registry.issueBindProof({ ...binding, browserCapability: "native-panel", native: true });
    const browser = registry.issueBindProof({ ...binding, browserCapability: "browser-panel" });
    const claimNative = () => registry.claimNative({ ...binding, bindProof: native });
    const claimBrowser = () => registry.claim({ ...binding, bindProof: browser });
    if (claimOrder === "native-first") {
      expect(claimNative().status).toBe("pending");
      expect(claimBrowser().status).toBe("pending");
    } else {
      expect(claimBrowser().status).toBe("pending");
      expect(claimNative().status).toBe("pending");
    }
    const activateBrowser = () => registry.activateBrowser({ ...binding, browserCapability: "browser-panel" });
    if (activationOrder === "native-first") {
      expect(registry.activateNative(nativeScope).status).toBe("active");
      expect(activateBrowser().status).toBe("active");
    } else {
      expect(activateBrowser().status).toBe("active");
      expect(registry.activateNative(nativeScope).status).toBe("active");
    }
    expect(registry.hasPresentationAuthority(nativeScope)).toBe(true);
    expect(registry.hasPresentationAuthority({ ...binding, browserCapabilityHash: digestSecretHex("browser-panel") })).toBe(true);
  });
});

describe("in-flight native authority checks", () => {
  it("invalidates only matching task/review checks and releases without tombstones", () => {
    const { registry } = registryFixture();
    const one = registry.beginAuthorityCheck({ taskSessionId: "task-a", reviewSessionId: "review-a", documentGeneration: 1 });
    const peer = registry.beginAuthorityCheck({ taskSessionId: "task-b", reviewSessionId: "review-b", documentGeneration: 1 });
    expect(registry.activityCount()).toBe(2);
    registry.revokeTask("task-a");
    expect(one.isCurrent()).toBe(false);
    expect(peer.isCurrent()).toBe(true);
    expect(registry.activityCount()).toBe(1);
    one.release();
    peer.release();
    expect(peer.isCurrent()).toBe(false);
    expect(registry.activityCount()).toBe(0);
  });
});

describe("advisory native reconnect hints", () => {
  function activateHint(registry: TaskBindingRegistry, task = "task-a", review = "review-a", pdfPath = "/private/tmp/paper.pdf") {
    const input = { taskSessionId: task, reviewSessionId: review, documentGeneration: 1, browserCapabilityHash: digestSecretHex(`native-${task}`) };
    const bindProof = registry.issueBindProof({ ...input, browserCapability: `native-${task}`, native: true });
    expect(registry.claimNative({ ...input, bindProof }).status).toBe("pending");
    expect(registry.rememberNativeReconnect({ ...input, pdfPath })).toBe(false);
    expect(registry.activateNative(input).status).toBe("active");
    expect(registry.rememberNativeReconnect({ ...input, pdfPath })).toBe(true);
    return input;
  }

  it("retains only same-task path guidance after detach without authority, ownership or activity", () => {
    const { registry } = registryFixture();
    const input = activateHint(registry);
    registry.detachPresentation(input.browserCapabilityHash);
    expect(registry.nativeReconnectForTask("task-a")).toMatchObject({ kind: "reopen-previous-source", pdfPath: "/private/tmp/paper.pdf" });
    expect(registry.nativeReconnectForTask("task-b")).toBeUndefined();
    expect(registry.bindingForTask("task-a")).toBeUndefined();
    expect(registry.hasPresentationAuthority(input)).toBe(false);
    expect(registry.activityCount()).toBe(0);
    expect(registry.activateNative(input)).toEqual({ status: "denied" });
    const peer = activateHint(registry, "task-b");
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    registry.detachPresentation(peer.browserCapabilityHash);
    expect(registry.nativeReconnectForTask("task-a")).toBeDefined();
  });

  it("uses fixed expiry, committed relocation and explicit revocation without guessing invalid paths", () => {
    const { registry, advance } = registryFixture();
    const input = activateHint(registry);
    registry.detachPresentation(input.browserCapabilityHash);
    const expiresAt = registry.nativeReconnectForTask("task-a")!.expiresAt;
    advance(24 * 60 * 60_000 - 1);
    expect(registry.nativeReconnectForTask("task-a")!.expiresAt).toBe(expiresAt);
    registry.relocateNativeReconnect("review-a", "/private/tmp/saved.pdf");
    expect(registry.nativeReconnectForTask("task-a")!.pdfPath).toBe("/private/tmp/saved.pdf");
    advance(1);
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    activateHint(registry);
    registry.relocateNativeReconnect("review-a", "relative.pdf");
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    registry.revokeTask("task-a");
    activateHint(registry);
    registry.revokeSession("review-a");
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    activateHint(registry);
    registry.revokeTask("task-a");
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
  });

  it("replaces prior targets on new verified activation and bounds inactive hint retention", () => {
    const { registry } = registryFixture();
    const first = activateHint(registry);
    registry.detachPresentation(first.browserCapabilityHash);
    const next = activateHint(registry, "task-a", "review-b", "/private/tmp/new.pdf");
    registry.detachPresentation(next.browserCapabilityHash);
    expect(registry.nativeReconnectForTask("task-a")!.pdfPath).toBe("/private/tmp/new.pdf");
    for (let index = 0; index < 256; index++) {
      const input = activateHint(registry, `task-${index}`, `review-${index}`);
      registry.detachPresentation(input.browserCapabilityHash);
    }
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    expect(registry.nativeReconnectForTask("task-255")).toBeDefined();
    expect(registry.activityCount()).toBe(0);
    registry.revokeAll();
    expect(registry.nativeReconnectForTask("task-255")).toBeUndefined();
  });

  it("clears historical native guidance when the task explicitly claims a different browser review", () => {
    const { registry } = registryFixture();
    const native = activateHint(registry);
    registry.detachPresentation(native.browserCapabilityHash);
    const bindProof = issue(registry, { reviewSessionId: "browser-review", browserCapability: "browser-new" });
    expect(registry.claim({ bindProof, taskSessionId: "task-a", reviewSessionId: "browser-review", documentGeneration: 1 }).status).toBe("pending");
    expect(registry.nativeReconnectForTask("task-a")).toBeUndefined();
    expect(registry.activateBrowser({ reviewSessionId: "browser-review", documentGeneration: 1, browserCapability: "browser-new" }).status).toBe("active");
  });
});
