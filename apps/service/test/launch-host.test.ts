import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";
import { TaskBindingRegistry } from "../src/context/task-binding-registry.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  readonly taskBindings?: TaskBindingRegistry;
  readonly validPdf?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-launch-"));
  roots.push(root);
  const pdf = join(root, "paper.pdf");
  const sourceRoot = join(root, "source");
  const assets = join(root, "assets");
  await mkdir(sourceRoot);
  await mkdir(assets);
  if (options.validPdf === true) {
    await copyFile(resolve("test/fixtures/pdfs/text-native.pdf"), pdf);
  } else {
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
  }
  await writeFile(join(assets, "app.js"), "export async function start(){ document.body.dataset.productionApp = 'ready' }\n");
  await writeFile(join(assets, "pdfium.wasm"), "offline-wasm");
  const host = await PlacekeeperHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: assets },
    ...(options.taskBindings === undefined ? {} : { taskBindings: options.taskBindings }),
  });
  hosts.push(host);
  return { root, pdf, sourceRoot, host };
}

describe("persistent launch host", () => {
  it("preflights unfamiliar links without reading the PDF or creating a session", async () => {
    const { root, host } = await fixture();
    const missing = join(root, "Long Unicode ⌘ missing.pdf");
    const link = encodePlacekeeperLink({ path: missing, location: { kind: "page", page: 12 } });

    await expect(host.preflightLink(link)).resolves.toEqual({
      ok: true,
      kind: "link-preflight",
      path: missing,
      confirmationRequired: true,
    });
    expect(host.broker.activity()).toEqual({ reviewPresence: 0, codexTasks: 0, transientWork: 0 });
    await expect(host.openLink({ link, confirmed: true })).resolves.toMatchObject({
      ok: false,
      error: { kind: "input-unavailable", message: expect.stringContaining("“Long Unicode ⌘ missing.pdf” is missing") },
    });
  });

  it("skips confirmation only for an exact active lexical path and rechecks before reading", async () => {
    const { root, pdf, host } = await fixture();
    const canonicalPdf = await realpath(pdf);
    const exact = encodePlacekeeperLink({ path: canonicalPdf, location: { kind: "page", page: 12 } });
    const aliasPath = join(root, "paper-alias.pdf");
    await symlink(pdf, aliasPath);
    const alias = encodePlacekeeperLink({ path: aliasPath, location: { kind: "page", page: 12 } });
    const opened = await host.open({ pdfPath: pdf });
    if (!opened.ok || opened.kind === "recovery-offered") throw new Error("Expected launch");

    await expect(host.preflightLink(exact)).resolves.toMatchObject({ confirmationRequired: false });
    await expect(host.preflightLink(alias)).resolves.toMatchObject({ confirmationRequired: true });
    await expect(host.openLink({ link: exact })).resolves.toMatchObject({
      ok: true,
      kind: "focused",
      sessionId: opened.sessionId,
    });

    await host.broker.finish(opened.sessionId);
    await unlink(pdf);
    await expect(host.openLink({ link: exact })).resolves.toEqual({
      ok: true,
      kind: "confirmation-required",
      path: canonicalPdf,
    });
  });

  it("opens a confirmed current PDF with safe location and no Codex scope", async () => {
    const { pdf, host } = await fixture({ validPdf: true });
    const location = {
      kind: "item" as const,
      page: 12,
      itemId: "00000000-0000-4000-8000-000000000123",
    };
    const link = encodePlacekeeperLink({ path: pdf, location });
    const launched = await host.openLink({ link, confirmed: true });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.kind === "confirmation-required") {
      throw new Error("Expected linked launch");
    }
    expect(launched).toMatchObject({ kind: "opened" });
    expect(launched).not.toHaveProperty("bindProof");
    const url = new URL(launched.url);
    const capability = new URLSearchParams(url.hash.slice(1)).get("cap")!;
    const exchanged = await fetch(`${url.origin}/s/${launched.sessionId}/exchange`, {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ capability }),
    });
    const { credential } = await exchanged.json() as { credential: string };
    await expect((await fetch(`${url.origin}/s/${launched.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    })).json()).resolves.toMatchObject({ launchSurface: "browser", requestedLocation: location });
  });

  it("names unreadable and non-PDF linked inputs without substitution", async () => {
    const { root, host } = await fixture();
    const unreadable = join(root, "unreadable.pdf");
    const notPdf = join(root, "named.pdf");
    await writeFile(unreadable, "%PDF-1.7\n");
    await chmod(unreadable, 0o000);
    await writeFile(notPdf, "plain text");
    try {
      for (const [path, detail] of [[unreadable, "unreadable"], [notPdf, "not a PDF"]] as const) {
        const response = await host.openLink({
          link: encodePlacekeeperLink({ path, location: { kind: "page", page: 3 } }),
          confirmed: true,
        });
        expect(response).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(detail) },
        });
      }
    } finally {
      await chmod(unreadable, 0o600);
    }
  });

  it("preserves linked location through the existing Protected Recovery choice", async () => {
    const { root, pdf, host } = await fixture();
    const canonicalPdf = await realpath(pdf);
    const location = { kind: "page" as const, page: 12 };
    const link = encodePlacekeeperLink({ path: canonicalPdf, location });
    const opened = await host.openLink({ link, confirmed: true });
    if (!opened.ok || opened.kind !== "opened") throw new Error("Expected linked review");
    await host.broker.acceptMutation(opened.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-17T12:00:00.000Z",
        updatedAt: "2026-08-17T12:00:00.000Z",
        payload: { position: { x: 1, y: 1, width: 18, height: 18 }, comment: "Recover linked location." },
      },
    });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    const restarted = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: join(root, "assets") },
    });
    hosts.push(restarted);
    const offered = await restarted.openLink({ link, confirmed: true });
    expect(offered).toMatchObject({
      ok: true,
      kind: "recovery-offered",
    });
    if (!offered.ok || offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openLink({
      link,
      confirmed: true,
      recovery: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (!resumed.ok || resumed.kind !== "opened") throw new Error("Expected linked recovery");
    const url = new URL(resumed.url);
    const capability = new URLSearchParams(url.hash.slice(1)).get("cap")!;
    const exchange = await fetch(`${url.origin}/s/${resumed.sessionId}/exchange`, {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ capability }),
    });
    const { credential } = await exchange.json() as { credential: string };
    await expect((await fetch(`${url.origin}/s/${resumed.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    })).json()).resolves.toMatchObject({ requestedLocation: location });
  });

  it("reports only aggregate bootstrap, bind-proof, and task activity", async () => {
    let now = Date.parse("2026-08-12T12:00:00.000Z");
    const taskBindings = new TaskBindingRegistry({
      now: () => new Date(now),
      pendingTtlMs: 1_000,
      activeLeaseTtlMs: 1_000,
    });
    const { pdf, host } = await fixture({ taskBindings, validPdf: true });
    const browser = await host.open({ pdfPath: pdf, surface: "browser" });
    if (!browser.ok || browser.kind === "recovery-offered") throw new Error("Expected browser launch");
    expect(host.broker.activity()).toEqual({
      reviewPresence: 1,
      codexTasks: 0,
      transientWork: 0,
    });

    const codex = await host.open({ pdfPath: pdf, surface: "codex" });
    if (!codex.ok || codex.kind === "recovery-offered" || codex.bindProof === undefined) {
      throw new Error("Expected Codex launch");
    }
    expect(host.broker.activity()).toEqual({
      reviewPresence: 2,
      codexTasks: 1,
      transientWork: 0,
    });
    now += 1_001;
    expect(host.broker.activity()).toEqual({
      reviewPresence: 2,
      codexTasks: 0,
      transientWork: 0,
    });
  });
  it("opens, focuses, and explicitly forks through one broker", async () => {
    const { pdf, sourceRoot, host } = await fixture();
    const opened = await host.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
    const focused = await host.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
    const forked = await host.open({ pdfPath: pdf, sourceRootPath: sourceRoot, fork: true });

    expect(opened).toMatchObject({ ok: true, kind: "opened" });
    expect(focused).toMatchObject({ ok: true, kind: "focused" });
    expect(forked).toMatchObject({ ok: true, kind: "opened" });
    if (
      !opened.ok || opened.kind === "recovery-offered" ||
      !focused.ok || focused.kind === "recovery-offered" ||
      !forked.ok || forked.kind === "recovery-offered"
    ) throw new Error("Expected launches");
    expect(new URL(opened.url).origin).toBe(host.server.origin);
    expect(focused.sessionId).toBe(opened.sessionId);
    expect(forked.sessionId).not.toBe(opened.sessionId);
  });

  it("attaches a newly approved source root when focusing an open review", async () => {
    const { pdf, sourceRoot, host } = await fixture();
    const opened = await host.open({ pdfPath: pdf, surface: "codex" });
    if (!opened.ok || opened.kind === "recovery-offered") throw new Error("Expected launch");

    const focused = await host.open({
      pdfPath: pdf,
      sourceRootPath: sourceRoot,
      surface: "codex",
    });
    expect(focused).toMatchObject({ ok: true, kind: "focused", sessionId: opened.sessionId });
    const canonicalSourceRoot = await realpath(sourceRoot);
    await expect(host.broker.snapshotAtomicSession(opened.sessionId)).resolves.toMatchObject({
      sourceRootPath: canonicalSourceRoot,
      state: { sourceRootId: expect.any(String) },
    });
  });

  it("issues an independent bind proof only for a Codex launch", async () => {
    const { pdf, host } = await fixture();
    const browser = await host.open({ pdfPath: pdf, surface: "browser" });
    const codex = await host.open({ pdfPath: pdf, surface: "codex" });
    const finder = await host.open({ pdfPath: pdf, surface: "finder", fork: true });
    if (
      !browser.ok || browser.kind === "recovery-offered" ||
      !codex.ok || codex.kind === "recovery-offered" ||
      !finder.ok || finder.kind === "recovery-offered"
    ) throw new Error("Expected launches");

    expect(browser).not.toHaveProperty("bindProof");
    expect(finder).not.toHaveProperty("bindProof");
    expect(codex.documentGeneration).toBe(1);
    expect(codex.bindProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(codex.url).not.toContain(codex.bindProof!);
  });

  it("activates a claimed task only after the authenticated Codex browser exchanges", async () => {
    const { pdf, host } = await fixture();
    const launched = await host.open({ pdfPath: pdf, surface: "codex" });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.bindProof === undefined) {
      throw new Error("Expected Codex launch");
    }
    const launch = new URL(launched.url);
    const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
    expect(host.broker.taskBindings.claim({
      bindProof: launched.bindProof,
      taskSessionId: "codex-task-a",
      reviewSessionId: launched.sessionId,
      documentGeneration: 1,
    })).toMatchObject({ status: "pending" });
    expect(host.broker.taskBindings.bindingForTask("codex-task-a")).toBeUndefined();
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/state`, {
      headers: { authorization: `Bearer ${launched.bindProof}` },
    })).status).toBe(401);

    const exchanged = await fetch(`${launch.origin}/s/${launched.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launch.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    const { credential } = await exchanged.json() as { credential: string };
    expect(host.broker.taskBindings.bindingForTask("codex-task-a")).toMatchObject({
      reviewSessionId: launched.sessionId,
      documentGeneration: 1,
    });

    const scope = await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const publicScope = await scope.text();
    expect(JSON.parse(publicScope)).toMatchObject({
      launchSurface: "codex",
      codexContext: {
        status: "refreshing",
        placekeeperSessionId: launched.sessionId,
        documentGeneration: 1,
      },
    });
    expect(publicScope).not.toContain(launched.bindProof);
    expect(publicScope).not.toContain(capability);

    await host.broker.finish(launched.sessionId);
    expect(host.broker.taskBindings.bindingForTask("codex-task-a")).toBeUndefined();
  });

  it("renews only authenticated Codex scope heartbeats and never shows stale review state as current", async () => {
    let now = Date.parse("2026-08-12T12:00:00.000Z");
    const taskBindings = new TaskBindingRegistry({
      now: () => new Date(now),
      pendingTtlMs: 1_000,
      activeLeaseTtlMs: 1_000,
    });
    // This is the production host/server path; only the clocked registry is injected.
    const { pdf, host: clockedHost } = await fixture({ taskBindings, validPdf: true });

    const launched = await clockedHost.open({ pdfPath: pdf, surface: "codex" });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.bindProof === undefined) {
      throw new Error("Expected Codex launch");
    }
    const launch = new URL(launched.url);
    const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
    expect(taskBindings.claim({
      bindProof: launched.bindProof,
      taskSessionId: "codex-task-heartbeat",
      reviewSessionId: launched.sessionId,
      documentGeneration: launched.documentGeneration,
    })).toMatchObject({ status: "pending" });
    const exchanged = await fetch(`${launch.origin}/s/${launched.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launch.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    const { credential } = await exchanged.json() as { credential: string };
    expect((await clockedHost.context.refresh({ taskSessionId: "codex-task-heartbeat" })).status).toBe("current");

    const currentScope = await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const currentScopeText = await currentScope.text();
    expect(JSON.parse(currentScopeText)).toMatchObject({
      launchSurface: "codex",
      codexContext: { status: "current", identity: { reviewRevision: 0 } },
    });
    expect(currentScopeText).not.toContain("codex-task-heartbeat");
    const firstRenewedExpiry = taskBindings.bindingForTask("codex-task-heartbeat")?.leaseExpiresAt;

    now += 250;
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/scope`)).status).toBe(401);
    expect(taskBindings.bindingForTask("codex-task-heartbeat")?.leaseExpiresAt).toBe(firstRenewedExpiry);

    const browserLaunch = await clockedHost.open({ pdfPath: pdf, surface: "browser" });
    if (!browserLaunch.ok || browserLaunch.kind === "recovery-offered") throw new Error("Expected browser launch");
    const browserUrl = new URL(browserLaunch.url);
    const browserCapability = new URLSearchParams(browserUrl.hash.slice(1)).get("cap")!;
    const browserExchange = await fetch(`${browserUrl.origin}/s/${browserLaunch.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: browserUrl.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability: browserCapability }),
    });
    const { credential: browserCredential } = await browserExchange.json() as { credential: string };
    expect((await fetch(`${browserUrl.origin}/s/${browserLaunch.sessionId}/scope`, {
      headers: { authorization: `Bearer ${browserCredential}` },
    })).status).toBe(200);
    expect(taskBindings.bindingForTask("codex-task-heartbeat")?.leaseExpiresAt).toBe(firstRenewedExpiry);

    const state = clockedHost.broker.state(launched.sessionId)!;
    await clockedHost.broker.acceptMutation(
      launched.sessionId,
      addPageNote(
        state,
        0,
        { x: 72, y: 80, width: 18, height: 18 },
        "Refresh this annotation.",
        {
          createId: () => "00000000-0000-4000-8000-000000000901",
          now: () => "2026-08-12T12:00:00.000Z",
        },
      ),
    );
    now += 250;
    const staleScope = await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(await staleScope.json()).toMatchObject({
      codexContext: { status: "refreshing", lastVerified: { reviewRevision: 0 } },
    });
    expect(taskBindings.bindingForTask("codex-task-heartbeat")?.leaseExpiresAt)
      .not.toBe(firstRenewedExpiry);

    now += 600;
    expect(taskBindings.bindingForTask("codex-task-heartbeat")).toBeDefined();
    expect((await clockedHost.context.refresh({ taskSessionId: "codex-task-heartbeat" })).status).toBe("current");
    const refreshedScope = await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(await refreshedScope.json()).toMatchObject({
      codexContext: { status: "current", identity: { reviewRevision: 1 } },
    });

    now += 1_001;
    expect(taskBindings.bindingForTask("codex-task-heartbeat")).toBeUndefined();
    await clockedHost.close();
    hosts.splice(hosts.indexOf(clockedHost), 1);
    expect(taskBindings.bindingForTask("codex-task-heartbeat")).toBeUndefined();
  });

  it.each(["browser", "finder", "vscode"] as const)(
    "never exposes ambient Codex binding status to a %s launch",
    async (surface) => {
      const { pdf, host } = await fixture();
      const launched = await host.open({ pdfPath: pdf, surface });
      if (!launched.ok || launched.kind === "recovery-offered") throw new Error("Expected launch");
      const launch = new URL(launched.url);
      const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
      const exchanged = await fetch(`${launch.origin}/s/${launched.sessionId}/exchange`, {
        method: "POST",
        headers: {
          origin: launch.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ capability }),
      });
      const { credential } = await exchanged.json() as { credential: string };
      const scope = await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(await scope.json()).toMatchObject({ launchSurface: surface });
      expect(await (await fetch(`${launch.origin}/s/${launched.sessionId}/scope`, {
        headers: { authorization: `Bearer ${credential}` },
      })).text()).not.toContain("codexContext");
      expect((await fetch(`${launch.origin}/s/${launched.sessionId}/delivery/codex/prepare`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          origin: launch.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      })).status).toBe(404);
    },
  );

  it("maps invalid input and unsupported roots to the two shared failures", async () => {
    const { root, pdf, host } = await fixture();
    const text = join(root, "not-a-pdf.txt");
    await writeFile(text, "no");

    await expect(host.open({ pdfPath: text })).resolves.toMatchObject({
      ok: false,
      error: { kind: "input-unavailable", recoveryAction: "Choose one readable local PDF" },
    });
    await expect(host.open({ pdfPath: pdf, sourceRootPath: join(root, "missing") })).resolves.toMatchObject({
      ok: false,
      error: { kind: "unsupported-context", recoveryAction: "Choose a supported local workspace" },
    });
  });

  it("offers recovery after a service restart and resumes only after an explicit choice", async () => {
    const { root, pdf, host } = await fixture();
    const opened = await host.open({ pdfPath: pdf });
    expect(opened).toMatchObject({ ok: true, kind: "opened" });
    if (!opened.ok || opened.kind === "recovery-offered") throw new Error("Expected launch");
    await host.broker.acceptMutation(opened.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:00.000Z",
        payload: {
          position: { x: 1, y: 1, width: 18, height: 18 },
          comment: "Recover this annotation.",
        },
      },
    });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    const restarted = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: join(root, "assets") },
    });
    hosts.push(restarted);
    const offered = await restarted.open({ pdfPath: pdf });
    expect(offered).toMatchObject({
      ok: true,
      kind: "recovery-offered",
      choices: ["resume", "discard", "fork"],
    });
    if (!offered.ok || offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.open({
      pdfPath: pdf,
      recovery: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    expect(resumed).toMatchObject({ ok: true, kind: "opened" });
  });

  it("serves public top-level assets and only enables authenticated VS Code assets and framing explicitly", async () => {
    const { pdf, host } = await fixture();
    const launched = await host.open({ pdfPath: pdf });
    if (!launched.ok || launched.kind === "recovery-offered") throw new Error("Expected launch");
    const launch = new URL(launched.url);
    const capability = new URLSearchParams(launch.hash.slice(1)).get("cap");
    expect(capability).toBeTruthy();

    const ordinary = await fetch(`${launch.origin}${launch.pathname}`);
    const ordinaryHtml = await ordinary.text();
    expect(ordinary.headers.get("x-frame-options")).toBe("DENY");
    expect(ordinaryHtml).toContain("type=\"module\"");
    expect(ordinaryHtml).toContain("<title>Placekeeper</title>");
    expect(ordinaryHtml).not.toContain("URL.createObjectURL");

    const exchanged = await fetch(`${launch.origin}/s/${launched.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launch.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
    const { credential } = await exchanged.json() as { credential: string };
    expect(cookie).toContain("placekeeper_view=");
    const app = await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
      headers: { cookie: cookie! },
    });
    expect(app.status).toBe(401);
    const publicApp = await fetch(`${launch.origin}/assets/app.js`);
    expect(publicApp.status).toBe(200);
    expect(await publicApp.text()).toContain("productionApp");
    const saveStatus = await fetch(`${launch.origin}/s/${launched.sessionId}/save/status`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const publicStatus = await saveStatus.text();
    expect(publicStatus).not.toContain("capabilityId");
    expect(publicStatus).not.toContain("fingerprint");
    expect(publicStatus).not.toContain("desiredDigest");
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/state`, {
      headers: { cookie: cookie! },
    })).status).toBe(401);

    const embeddedLaunch = await host.open({ pdfPath: pdf, surface: "vscode" });
    if (!embeddedLaunch.ok || embeddedLaunch.kind === "recovery-offered") throw new Error("Expected embedded launch");
    const embeddedUrl = new URL(embeddedLaunch.url);
    const embeddedCapability = new URLSearchParams(embeddedUrl.hash.slice(1)).get("cap");
    const secondExchange = await fetch(`${launch.origin}/s/${launched.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launch.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability: embeddedCapability }),
    });
    const secondCookie = secondExchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(secondCookie).toContain("placekeeper_session=");
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
      headers: { cookie: cookie! },
    })).status).toBe(401);
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
      headers: { cookie: secondCookie! },
    })).status).toBe(200);

    const embedded = await fetch(embeddedLaunch.url.replace(/#.*$/u, ""));
    expect(embedded.headers.get("x-frame-options")).toBeNull();
    expect(embedded.headers.get("content-security-policy")).toContain("frame-ancestors vscode-webview:");

    await host.broker.finish(launched.sessionId);
    for (const revokedCookie of [cookie, secondCookie]) {
      expect((await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
        headers: { cookie: revokedCookie! },
      })).status).toBe(401);
    }
  });
});
