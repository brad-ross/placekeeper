import { describe, expect, it } from "vitest";

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

describe("task-scoped PDF binding registry", () => {
  it("requires a one-time hook claim followed by the matching browser activation", () => {
    const { registry } = registryFixture();
    const bindProof = issue(registry);

    expect(registry.claim({
      bindProof,
      taskSessionId: "task-a",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    })).toMatchObject({ status: "pending" });
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
    expect(registry.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
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

  it("expires pending claims and active leases and supports explicit lifecycle revocation", () => {
    const { registry, advance } = registryFixture();
    const pendingProof = issue(registry);
    registry.claim({
      bindProof: pendingProof,
      taskSessionId: "task-pending",
      reviewSessionId: "review-a",
      documentGeneration: 1,
    });
    advance(101);
    expect(registry.bindingForTask("task-pending")).toBeUndefined();

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
