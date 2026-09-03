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
