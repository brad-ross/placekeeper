import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProofreaderHost } from "../src/host/proofreader-host.js";

const roots: string[] = [];
const hosts: ProofreaderHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-launch-"));
  roots.push(root);
  const pdf = join(root, "paper.pdf");
  const sourceRoot = join(root, "source");
  const assets = join(root, "assets");
  await mkdir(sourceRoot);
  await mkdir(assets);
  await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
  await writeFile(join(assets, "app.js"), "export async function start(){ document.body.dataset.productionApp = 'ready' }\n");
  await writeFile(join(assets, "pdfium.wasm"), "offline-wasm");
  const host = await ProofreaderHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: assets },
  });
  hosts.push(host);
  return { root, pdf, sourceRoot, host };
}

describe("persistent launch host", () => {
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

    const restarted = await ProofreaderHost.start({
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
    const resumed = await restarted.open({ pdfPath: pdf, recovery: "resume" });
    expect(resumed).toMatchObject({ ok: true, kind: "opened" });
  });

  it("serves authenticated normal module assets and only enables the VS Code frame policy explicitly", async () => {
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
    expect(cookie).toContain("proofreader_session=");
    const app = await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
      headers: { cookie: cookie! },
    });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("productionApp");
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
    expect((await fetch(`${launch.origin}/s/${launched.sessionId}/assets/app.js`, {
      headers: { cookie: cookie! },
    })).status).toBe(200);
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
