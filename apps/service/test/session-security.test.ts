import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionCredentialStore,
  validateRequestSecurity,
  type RequestSecurityContext,
} from "../../../packages/core/src/session-security.js";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";
import { FileCapabilityRegistry } from "../src/files/file-capabilities.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";
import {
  PLACEKEEPER_HTTP_PORT,
  startHttpServer,
  type LocalHttpServer,
} from "../src/server/http-server.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import type { SessionLaunch } from "../src/sessions/session-broker.js";
import { SessionControlRegistry } from "../src/sessions/control-socket.js";

const temporaryDirectories: string[] = [];
const servers: LocalHttpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "placekeeper-security-"));
  temporaryDirectories.push(path);
  return path;
}

function secureRequest(
  overrides: Partial<RequestSecurityContext> = {},
): RequestSecurityContext {
  return {
    method: "POST",
    rawHeaders: ["Host", "127.0.0.1:43123"],
    headers: {
      host: "127.0.0.1:43123",
      origin: "http://127.0.0.1:43123",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    remoteAddress: "127.0.0.1",
    mutates: true,
    expectsJson: true,
    bodyLength: 10,
    ...overrides,
  };
}

describe("one-use document-scoped session credentials", () => {
  it("keeps the Codex bootstrap valid after the same PDF is focused from another surface", async () => {
    const root = await temporaryDirectory();
    const pdf = join(root, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\n%%EOF");
    const broker = new SessionBroker({
      recoveryRoot: join(root, "recovery"),
      portableReader: async () => [],
      rewriteAssessor: async () => ({ eligible: true }),
    });
    const codex = await broker.openReview({ pdfPath: pdf, surface: "codex" });
    const finder = await broker.openReview({ pdfPath: pdf, surface: "finder" });
    if (codex.kind !== "opened" || finder.kind !== "focused") throw new Error("Expected dual launch");
    const codexCapability = new URLSearchParams(codex.launch.fragment.slice(1)).get("cap");
    const finderCapability = new URLSearchParams(finder.launch.fragment.slice(1)).get("cap");
    expect(codexCapability).not.toBeNull();
    expect(finderCapability).not.toBeNull();
    expect(broker.credentials.exchangeBootstrap(codex.launch.sessionId, codexCapability!)).toHaveLength(43);
    expect(broker.credentials.exchangeBootstrap(finder.launch.sessionId, finderCapability!)).toHaveLength(43);
  });

  it("keeps earlier same-session launches valid while bounding pending capabilities", () => {
    const credentials = new SessionCredentialStore();
    const first = credentials.issueBootstrap("session-a");
    const second = credentials.issueBootstrap("session-a");
    expect(credentials.pendingBootstrapCount()).toBe(2);
    expect(credentials.exchangeBootstrap("session-a", first)).toHaveLength(43);
    expect(credentials.exchangeBootstrap("session-a", second)).toHaveLength(43);
    expect(credentials.pendingBootstrapCount()).toBe(0);

    const launches = Array.from({ length: 10 }, () => credentials.issueBootstrap("session-b"));
    expect(credentials.pendingBootstrapCount()).toBe(8);
    expect(credentials.exchangeBootstrap("session-b", launches[0]!)).toBeUndefined();
    expect(credentials.exchangeBootstrap("session-b", launches.at(-1)!)).toHaveLength(43);
    credentials.revokeSession("session-b");
    expect(credentials.pendingBootstrapCount()).toBe(0);
  });

  it("rejects expiry, replay, cross-session theft, and revoked credentials", () => {
    let now = 1_000;
    const credentials = new SessionCredentialStore(() => now);
    const expired = credentials.issueBootstrap("session-a", 10);
    expect(credentials.pendingBootstrapCount()).toBe(1);
    now += 11;
    expect(credentials.pendingBootstrapCount()).toBe(0);
    expect(credentials.exchangeBootstrap("session-a", expired)).toBeUndefined();

    const boundary = credentials.issueBootstrap("session-a", 10);
    now += 10;
    expect(credentials.exchangeBootstrap("session-a", boundary)).toBeUndefined();

    const capability = credentials.issueBootstrap("session-a");
    expect(credentials.pendingBootstrapCount()).toBe(1);
    const credential = credentials.exchangeBootstrap("session-a", capability);
    expect(credentials.pendingBootstrapCount()).toBe(0);
    expect(credential).toHaveLength(43);
    expect(credentials.exchangeBootstrap("session-a", capability)).toBeUndefined();
    expect(credentials.authenticate("session-a", credential!)).toBe(true);
    expect(credentials.authenticate("session-b", credential!)).toBe(false);
    expect(credentials.authenticate("session-a", `${credential!.slice(0, -1)}x`)).toBe(false);
    credentials.revokeSession("session-a");
    expect(credentials.authenticate("session-a", credential!)).toBe(false);
  });

  it("invalidates predecessor bootstraps without revoking authenticated successor views", () => {
    const credentials = new SessionCredentialStore();
    const activeCapability = credentials.issueBootstrap("session-a");
    const activeCredential = credentials.exchangeBootstrap("session-a", activeCapability)!;
    const staleCapability = credentials.issueBootstrap("session-a");
    credentials.revokePendingBootstraps("session-a");
    expect(credentials.exchangeBootstrap("session-a", staleCapability)).toBeUndefined();
    expect(credentials.authenticate("session-a", activeCredential)).toBe(true);
  });
});

describe("authenticated review presence", () => {
  function maskedFrame(payload: string, options: { final?: boolean; opcode?: number } = {}): Buffer {
    const bytes = Buffer.from(payload);
    const mask = Buffer.from([1, 2, 3, 4]);
    const encoded = Buffer.from(bytes.map((value, index) => value ^ mask[index % 4]!));
    return Buffer.concat([
      Buffer.from([(options.final ?? true ? 0x80 : 0) | (options.opcode ?? 1), 0x80 | bytes.length]),
      mask,
      encoded,
    ]);
  }

  it("keeps multiple clients active, leases the last disconnect, and cancels grace on reconnect", () => {
    let now = 1_000;
    const controls = new SessionControlRegistry({
      now: () => now,
      presenceGraceMs: 500,
      heartbeat: false,
    });
    const disconnectFirst = controls.registerSocket("review-a", new PassThrough());
    const disconnectSecond = controls.registerSocket("review-a", new PassThrough());

    expect(controls.activity()).toEqual({ reviewPresence: 2, transientWork: 0 });
    disconnectFirst();
    expect(controls.activity()).toEqual({ reviewPresence: 1, transientWork: 0 });
    disconnectSecond();
    expect(controls.activity()).toEqual({ reviewPresence: 1, transientWork: 0 });

    now += 250;
    const reconnect = controls.registerSocket("review-a", new PassThrough());
    expect(controls.activity()).toEqual({ reviewPresence: 1, transientWork: 0 });
    reconnect();
    now += 499;
    expect(controls.activity()).toEqual({ reviewPresence: 1, transientWork: 0 });
    now += 1;
    expect(controls.activity()).toEqual({ reviewPresence: 0, transientWork: 0 });
  });

  it("counts accepted durable work separately from review presence", () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const write = controls.beginWrite("review-a");
    expect(controls.activity()).toEqual({ reviewPresence: 0, transientWork: 1 });
    write.complete();
    expect(controls.activity()).toEqual({ reviewPresence: 0, transientWork: 0 });
  });

  it.each([
    ["malformed", maskedFrame("not-json")],
    ["fragmented", maskedFrame('{"kind":"presence"}', { final: false })],
    ["oversized", Buffer.from([0x81, 0xfe, 0x04, 0x01])],
    ["flooded", Buffer.concat([
      maskedFrame('{"kind":"presence"}'),
      maskedFrame('{"kind":"presence"}'),
    ])],
  ])("rejects %s application frames without prolonging presence", (_label, frame) => {
    const controls = new SessionControlRegistry({ heartbeat: false, presenceGraceMs: 100 });
    const socket = new PassThrough();
    controls.registerSocket("review-a", socket);
    socket.write(frame);
    expect(socket.destroyed).toBe(true);
  });
});

describe("request preflight", () => {
  const policy = {
    host: "127.0.0.1:43123",
    origin: "http://127.0.0.1:43123",
    maxBodyBytes: 1_024,
  };

  it("accepts only the exact loopback peer and exact single Host", () => {
    expect(validateRequestSecurity(secureRequest(), policy)).toBeUndefined();
    expect(
      validateRequestSecurity(
        secureRequest({ remoteAddress: "192.0.2.1" }),
        policy,
      ),
    ).toBe("peer");
    expect(
      validateRequestSecurity(
        secureRequest({ rawHeaders: ["Host", "localhost:43123"] }),
        policy,
      ),
    ).toBe("host");
    expect(
      validateRequestSecurity(
        secureRequest({
          rawHeaders: [
            "Host",
            "127.0.0.1:43123",
            "Host",
            "127.0.0.1:43123",
          ],
        }),
        policy,
      ),
    ).toBe("host");
  });

  it.each([
    ["forwarding header", { headers: { ...secureRequest().headers, forwarded: "for=127.0.0.1" } }, "forwarded"],
    ["cross-site Fetch Metadata", { headers: { ...secureRequest().headers, "sec-fetch-site": "cross-site" } }, "cross-site"],
    ["null Origin", { headers: { ...secureRequest().headers, origin: "null" } }, "origin"],
    ["state-changing GET", { method: "GET" }, "method"],
    ["form content type", { headers: { ...secureRequest().headers, "content-type": "application/x-www-form-urlencoded" } }, "content-type"],
    ["oversized body", { bodyLength: 1_025 }, "body-size"],
  ] as const)("rejects %s", (_label, overrides, failure) => {
    expect(
      validateRequestSecurity(
        secureRequest(overrides as Partial<RequestSecurityContext>),
        policy,
      ),
    ).toBe(failure);
  });
});

describe("opaque file and root capabilities", () => {
  it("rejects traversal, absolute paths, sibling prefixes, and escaping symlinks", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "root");
    const sibling = join(directory, "root-sibling");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(root, "inside.tex"), "inside");
    await writeFile(join(sibling, "outside.tex"), "outside");
    await symlink(join(sibling, "outside.tex"), join(root, "escape.tex"));
    const capabilities = new FileCapabilityRegistry();
    const approved = await capabilities.approveRoot(root);

    await expect(capabilities.resolveRootEntry(approved.id, "inside.tex")).resolves.toBe(
      join(approved.canonicalPath, "inside.tex"),
    );
    await expect(capabilities.resolveRootEntry(approved.id, "../root-sibling/outside.tex")).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await expect(capabilities.resolveRootEntry(approved.id, join(sibling, "outside.tex"))).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(capabilities.resolveRootEntry(approved.id, "escape.tex")).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await expect(capabilities.resolveRootEntry(approved.id, "file:///etc/passwd")).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("detects destination appearance and original source drift immediately before commit", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    const capabilities = new FileCapabilityRegistry();
    const approved = await capabilities.approvePdf(pdf);
    const destination = join(directory, "reviewed.pdf");
    const destinationCapability = await capabilities.preauthorizeDestination(destination);
    await writeFile(destination, "swapped");
    await expect(capabilities.validateDestination(destinationCapability.id)).rejects.toMatchObject({ code: "TARGET_CHANGED" });

    const originalBytes = await readFile(pdf);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(originalBytes).digest("hex");
    await writeFile(pdf, "%PDF-1.7\nrebuilt\n%%EOF");
    await expect(capabilities.validateOriginalForReplacement(approved.id, digest)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});

async function openBroker(): Promise<{
  directory: string;
  pdf: string;
  broker: SessionBroker;
  launch: SessionLaunch;
  server: LocalHttpServer;
}> {
  const directory = await temporaryDirectory();
  const pdf = join(directory, "paper.pdf");
  const assets = join(directory, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "app.js"), "export function start() {}\n");
  await writeFile(pdf, "%PDF-1.7\nprivate document text\n%%EOF");
  const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery") });
  const opened = await broker.openReview({ pdfPath: pdf });
  if (opened.kind !== "opened") throw new Error("Expected a new review");
  const server = await startHttpServer(broker, { webAssets: { root: assets } });
  servers.push(server);
  return { directory, pdf, broker, launch: opened.launch, server };
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const origin = new URL(url).origin;
  return fetch(url, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("loopback HTTP boundary", () => {
  it("keeps a stale readable GET outside every local-file and authority boundary", async () => {
    const directory = await temporaryDirectory();
    const assets = join(directory, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start() {}\n");
    const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery") });
    const approvePdf = vi.spyOn(broker.capabilities, "approvePdf");
    const recoverDraft = vi.spyOn(DraftSnapshotStore.prototype, "recover");
    const openReview = vi.spyOn(broker, "openReview");
    const stageReconnect = vi.spyOn(broker, "stageRestartReconnect");
    const issueBootstrap = vi.spyOn(broker.credentials, "issueBootstrap");
    const server = await startHttpServer(broker, { webAssets: { root: assets } });
    servers.push(server);
    const viewId = randomUUID();

    const response = await fetch(
      `${server.origin}/r/${viewId}/private/tmp/Stale%20Paper.pdf#v=1&page=4`,
      { headers: { cookie: "placekeeper_view=stale; placekeeper_reconnect=stale" } },
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`Path=/r/${viewId}/`);
    expect(html).toContain("data-terminal-recovery");
    expect(approvePdf).not.toHaveBeenCalled();
    expect(recoverDraft).not.toHaveBeenCalled();
    expect(openReview).not.toHaveBeenCalled();
    expect(stageReconnect).not.toHaveBeenCalled();
    expect(issueBootstrap).not.toHaveBeenCalled();
  });

  it("keeps stale-session reopen same-origin, confirmed, and browser-scoped", async () => {
    const { pdf, broker, launch, server } = await openBroker();
    await broker.finish(launch.sessionId);
    const reopenUrl = `${server.origin}/reopen`;
    const link = encodePlacekeeperLink({ path: pdf, location: { kind: "page", page: 3 } });

    expect((await postJson(reopenUrl, { link }, { origin: "http://127.0.0.1:1" })).status)
      .toBe(403);
    expect((await fetch(reopenUrl, {
      method: "POST",
      headers: {
        origin: server.origin,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: "link=unsafe",
    })).status).toBe(403);
    expect((await postJson(reopenUrl, { link: "placekeeper:///invalid#fragment" })).status)
      .toBe(409);
    expect((await postJson(reopenUrl, {
      link,
      confirmed: true,
      recovery: "resume",
    })).status).toBe(400);
    expect((await postJson(reopenUrl, {
      link,
      confirmed: true,
      recovery: "resume",
      recoveryOffer: {
        id: "opaque_recovery_offer_1234",
        expiresAt: "2026-08-21T20:00:00.000Z",
      },
    })).status).toBe(400);
    const unavailable = await postJson(reopenUrl, {
      link,
      confirmed: true,
      recovery: "resume",
      recoveryOffer: {
        id: "opaque_recovery_offer_1234",
        expiresAt: "2026-08-21T20:00:00.000Z",
      },
      recoveryOperationId: "operation_identifier_1234",
    });
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toEqual({
      ok: false,
      error: { kind: "recovery-offer-unavailable" },
    });

    const confirmation = await postJson(reopenUrl, { link });
    expect(await confirmation.json()).toEqual({
      ok: true,
      kind: "confirmation-required",
      path: pdf,
    });
    const reopened = await postJson(reopenUrl, { link, confirmed: true });
    const result = await reopened.json() as {
      ok: true;
      kind: "opened" | "focused";
      url: string;
      bindProof?: string;
    };
    expect(result).toMatchObject({ ok: true, kind: "opened" });
    expect(result).not.toHaveProperty("bindProof");
    const target = new URL(result.url);
    expect(target.origin).toBe(server.origin);
    const capability = new URLSearchParams(target.hash.slice(1)).get("cap");
    const sessionId = /^\/s\/([^/]+)\/bootstrap$/u.exec(target.pathname)?.[1];
    expect(capability).toBeTruthy();
    expect(sessionId).toBeTruthy();
    const exchange = await postJson(`${server.origin}/s/${sessionId}/exchange`, { capability });
    const { credential } = await exchange.json() as { credential: string };
    await expect((await fetch(`${server.origin}/s/${sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    })).json()).resolves.toMatchObject({
      launchSurface: "browser",
      requestedLocation: { kind: "page", page: 3 },
    });
  });

  it("supports an explicit fixed loopback port and fails on collision without falling back", async () => {
    expect(PLACEKEEPER_HTTP_PORT).toBeGreaterThan(1_024);
    expect(PLACEKEEPER_HTTP_PORT).toBeLessThanOrEqual(65_535);
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP blocker");
    const directory = await temporaryDirectory();
    const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery") });

    await expect(startHttpServer(broker, { port: address.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    const rebound = await startHttpServer(broker, { port: address.port });
    servers.push(rebound);
    expect(rebound.port).toBe(address.port);
  });

  it("exchanges the fragment once, scrubs it before protected assets, and scopes all bytes", async () => {
    const { broker, launch, server } = await openBroker();
    const bootstrap = await fetch(`${server.origin}${launch.launchPath}`);
    const html = await bootstrap.text();
    expect(bootstrap.status).toBe(200);
    expect(html).not.toContain(launch.fragment.slice("#cap=".length));
    expect(html).toContain("location.replace(view.pathname");
    expect(html).not.toContain("stylesheet.href");
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/u);
    expect(bootstrap.headers.get("content-security-policy")).toContain("default-src 'none'");

    const assetBeforeExchange = await fetch(
      `${server.origin}/s/${launch.sessionId}/assets/app.js`,
    );
    expect(assetBeforeExchange.status).toBe(401);

    const capability = launch.fragment.slice("#cap=".length);
    const exchanged = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability },
    );
    expect(exchanged.status).toBe(200);
    const { credential } = (await exchanged.json()) as { credential: string };
    const viewCookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
    const replay = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability },
    );
    expect(replay.status).toBe(401);

    const authorization = { authorization: `Bearer ${credential}` };
    const asset = await fetch(
      `${server.origin}/s/${launch.sessionId}/assets/app.js`,
      { headers: { cookie: viewCookie! } },
    );
    expect(asset.status).toBe(401);
    expect((await fetch(`${server.origin}/assets/app.js`)).status).toBe(200);
    const document = await fetch(
      `${server.origin}/s/${launch.sessionId}/document/${launch.fileId}`,
      { headers: authorization },
    );
    expect(document.status).toBe(200);
    expect(await document.text()).toContain("private document text");
    const arbitrary = await fetch(
      `${server.origin}/s/${launch.sessionId}/document/${randomUUID()}`,
      { headers: authorization },
    );
    expect(arbitrary.status).toBe(404);
    expect(broker.state(launch.sessionId)?.revision).toBe(0);
  });

  it("resumes a live readable view repeatedly with only its scoped HttpOnly cookie", async () => {
    const { broker, launch, pdf, server } = await openBroker();
    const capability = launch.fragment.slice("#cap=".length);
    const exchanged = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability },
    );
    expect(exchanged.status).toBe(200);
    const exchangeBody = await exchanged.json() as {
      credential: string;
      view: { id: string; pathname: string; locationFragment: string };
    };
    expect(exchangeBody.view).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      pathname: expect.stringMatching(/^\/r\/[0-9a-f-]{36}\/.+paper\.pdf$/u),
      locationFragment: "v=1&page=1",
    });
    expect(exchangeBody.view.pathname).not.toContain(capability);
    expect(exchangeBody.view.pathname).not.toContain(exchangeBody.credential);

    const setCookie = exchanged.headers.get("set-cookie");
    expect(setCookie).toContain("placekeeper_view=");
    expect(setCookie).toContain(`Path=/r/${exchangeBody.view.id}/`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
    const cookie = setCookie!.split(";", 1)[0]!;

    const shellResponse = await fetch(`${server.origin}${exchangeBody.view.pathname}`);
    const shell = await shellResponse.text();
    expect(shellResponse.status).toBe(200);
    expect(shell).not.toContain("private document text");
    expect(shell).not.toContain(capability);
    expect(shell).not.toContain(exchangeBody.credential);
    expect(shell).not.toContain(launch.sessionId);

    const publicAsset = await fetch(`${server.origin}/assets/app.js`);
    expect(publicAsset.status).toBe(200);

    const resumeUrl = `${server.origin}/r/${exchangeBody.view.id}/resume`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resumed = await postJson(
        resumeUrl,
        { pathname: exchangeBody.view.pathname },
        { cookie },
      );
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({
        sessionId: launch.sessionId,
        credential: exchangeBody.credential,
        appLinkBase: `placekeeper://${exchangeBody.view.pathname.replace(/^\/r\/[0-9a-f-]{36}/u, "")}`,
      });
    }

    expect((await postJson(resumeUrl, { pathname: exchangeBody.view.pathname })).status).toBe(401);
    expect((await postJson(
      `${server.origin}/r/${randomUUID()}/resume`,
      { pathname: exchangeBody.view.pathname },
      { cookie },
    )).status).toBe(401);
    expect((await postJson(resumeUrl, { pathname: `${exchangeBody.view.pathname}-wrong` }, { cookie })).status).toBe(401);
    expect((await postJson(resumeUrl, { pathname: exchangeBody.view.pathname }, { cookie: "placekeeper_view=wrong" })).status).toBe(401);
    expect((await postJson(resumeUrl, { pathname: exchangeBody.view.pathname }, { cookie, origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await postJson(
      `http://localhost:${server.port}/r/${exchangeBody.view.id}/resume`,
      { pathname: exchangeBody.view.pathname },
      { cookie },
    )).status).toBe(403);

    const copiedState = await fetch(`${server.origin}/s/${launch.sessionId}/state`);
    expect(copiedState.status).toBe(401);
    broker.revokeView(exchangeBody.view.id);
    expect((await postJson(resumeUrl, { pathname: exchangeBody.view.pathname }, { cookie })).status).toBe(401);
    expect((await fetch(`${server.origin}/s/${launch.sessionId}/state`, {
      headers: { authorization: `Bearer ${exchangeBody.credential}` },
    })).status).toBe(401);
    const revokedRoute = await fetch(
      `${server.origin}${exchangeBody.view.pathname}#v=1&page=7`,
      { headers: { cookie } },
    );
    const revokedHtml = await revokedRoute.text();
    expect(revokedRoute.status).toBe(200);
    expect(revokedRoute.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(revokedHtml).toContain("data-terminal-recovery");
    expect(revokedHtml).toContain("placekeeper:///");
    expect(revokedHtml).toContain('href="#" aria-disabled="true"');
    expect(revokedHtml).toContain('reopen.dataset.appLinkBase + "#v=1&page=1"');
    expect(revokedHtml).toContain("showTerminalRecovery");
    expect(revokedHtml).not.toContain("/resume");
    expect(revokedHtml).not.toContain(launch.sessionId);
    expect(revokedHtml).not.toContain(exchangeBody.credential);
    expect(revokedHtml).not.toContain(capability);

    const unknownViewId = randomUUID();
    const unknownPath = `/r/${unknownViewId}/private/tmp/Unknown%20Paper.pdf`;
    const unknown = await fetch(`${server.origin}${unknownPath}#unsafe`, {
      headers: { cookie: "placekeeper_view=stale-successor-cookie" },
    });
    const unknownHtml = await unknown.text();
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("set-cookie")).toContain(`Path=/r/${unknownViewId}/`);
    expect(unknown.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(unknownHtml).toContain('data-app-link-base="placekeeper:///private/tmp/Unknown%20Paper.pdf"');
    expect(unknownHtml).toContain('href="#" aria-disabled="true"');
    expect(unknownHtml).not.toContain("fetch(");
    expect(unknownHtml).not.toContain("location.assign");
    expect(unknownHtml).not.toContain("location.replace");
    expect(unknownHtml).not.toContain(launch.sessionId);
    expect(unknownHtml).not.toContain(exchangeBody.credential);
    expect((await fetch(
      `${server.origin}/r/${randomUUID()}/private/tmp/Bad%2FPath.pdf`,
      { headers: { cookie: "placekeeper_view=stale-successor-cookie" } },
    )).status).toBe(404);

    const reopened = await broker.openReview({ pdfPath: pdf, surface: "browser" });
    if (reopened.kind !== "focused") throw new Error("Expected another live view");
    const endedExchange = await postJson(
      `${server.origin}/s/${reopened.launch.sessionId}/exchange`,
      { capability: reopened.launch.fragment.slice("#cap=".length) },
    );
    const endedBody = await endedExchange.json() as {
      view: { id: string; pathname: string };
    };
    const endedCookie = endedExchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    await broker.finish(reopened.launch.sessionId);
    expect((await postJson(
      `${server.origin}/r/${endedBody.view.id}/resume`,
      { pathname: endedBody.view.pathname },
      { cookie: endedCookie },
    )).status).toBe(401);
  });

  it("rejects hostile forms, aliases, forwarding, cross-site metadata, null origins, and oversized bodies without mutation", async () => {
    const { broker, launch, server } = await openBroker();
    const capability = launch.fragment.slice("#cap=".length);
    const exchange = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability },
    );
    const { credential } = (await exchange.json()) as { credential: string };
    const commandUrl = `${server.origin}/s/${launch.sessionId}/commands`;
    const command = {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "highlight",
        pageIndex: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payload: { comment: "must not persist" },
      },
    };
    const auth = { authorization: `Bearer ${credential}` };
    expect(
      (await fetch(commandUrl, { method: "POST", headers: { ...auth, origin: server.origin, "content-type": "application/x-www-form-urlencoded" }, body: "x=1" })).status,
    ).toBe(403);
    expect(
      (await fetch(commandUrl, { method: "POST", headers: { ...auth, origin: "null", "content-type": "application/json" }, body: JSON.stringify(command) })).status,
    ).toBe(403);
    expect(
      (await postJson(commandUrl, command, { ...auth, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await postJson(commandUrl, command, { ...auth, forwarded: "for=127.0.0.1" })).status,
    ).toBe(403);
    expect(
      (await fetch(commandUrl, { method: "GET", headers: auth })).status,
    ).not.toBe(200);
    expect(
      (await fetch(`http://localhost:${server.port}/s/${launch.sessionId}/state`, { headers: auth })).status,
    ).toBe(403);
    expect(
      (await fetch(commandUrl, {
        method: "POST",
        headers: { ...auth, origin: server.origin, "content-type": "application/json" },
        body: `"${"x".repeat(256 * 1024)}"`,
      })).status,
    ).toBe(413);
    expect(
      (await postJson(
        commandUrl,
        { type: "unknown", expectedRevision: 0 },
        auth,
      )).status,
    ).toBe(422);
    for (const malformed of [null, [], { type: "add" }]) {
      const response = await postJson(commandUrl, malformed, auth);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          kind: "invalid-review-command",
          message: "Review command is malformed",
        },
      });
    }
    expect(broker.state(launch.sessionId)?.revision).toBe(0);
  });

  it("returns an actionable command error before an oversized selection reaches saving", async () => {
    const { broker, launch, server } = await openBroker();
    const exchange = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability: launch.fragment.slice("#cap=".length) },
    );
    const { credential } = await exchange.json() as { credential: string };
    const timestamp = "2026-08-25T12:00:00.000Z";
    const segment = { x: 72, y: 92, width: 12, height: 8 };
    const response = await postJson(`${server.origin}/s/${launch.sessionId}/commands`, {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "highlight",
        pageIndex: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        payload: {
          quote: "selection",
          prefix: "",
          suffix: "",
          rect: { x: 72, y: 92, width: 120, height: 40 },
          segmentRects: Array.from({ length: 257 }, () => ({ ...segment })),
          reliable: true,
        },
      },
    }, { authorization: `Bearer ${credential}` });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        kind: "invalid-review-command",
        message: "Selections can contain at most 256 text segments. Shorten the selection and try again.",
      },
    });
    expect(broker.state(launch.sessionId)?.revision).toBe(0);
  });

  it("rejects an oversized editable metadata envelope before accepting the command", async () => {
    const { broker, launch, server } = await openBroker();
    const exchange = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability: launch.fragment.slice("#cap=".length) },
    );
    const { credential } = await exchange.json() as { credential: string };
    const timestamp = "2026-08-25T12:00:00.000Z";
    const response = await postJson(`${server.origin}/s/${launch.sessionId}/commands`, {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "highlight",
        pageIndex: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        payload: {
          quote: "q".repeat(16 * 1024),
          prefix: "",
          suffix: "",
          rect: { x: 72, y: 92, width: 120, height: 8 },
          segmentRects: [{ x: 72, y: 92, width: 120, height: 8 }],
          reliable: true,
          comment: "c".repeat(16 * 1024),
        },
      },
    }, { authorization: `Bearer ${credential}` });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        kind: "invalid-review-command",
        message: "This annotation contains too much text or geometry to preserve as editable metadata. Shorten it and try again.",
      },
    });
    expect(broker.state(launch.sessionId)?.revision).toBe(0);
  });

  it("rejects duplicate Host and unauthenticated upgraded connections", async () => {
    const { launch, server } = await openBroker();
    const rawStatus = await new Promise<number>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: server.port });
      let response = "";
      socket.on("connect", () => {
        socket.write(
          `GET /s/${launch.sessionId}/state HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        response += chunk.toString();
      });
      socket.on("end", () => {
        resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1] ?? 0));
      });
      socket.on("error", reject);
    });
    expect(rawStatus).toBe(403);

    const upgradeClosed = await new Promise<boolean>((resolve) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: `/s/${launch.sessionId}/control`,
        headers: {
          host: `127.0.0.1:${server.port}`,
          origin: server.origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      });
      request.on("upgrade", () => resolve(false));
      request.on("error", () => resolve(true));
      request.on("close", () => resolve(true));
      request.end();
    });
    expect(upgradeClosed).toBe(true);
  });

  it("authenticates upgraded connections without reflecting the credential", async () => {
    const { broker, launch, server } = await openBroker();
    const exchange = await postJson(
      `${server.origin}/s/${launch.sessionId}/exchange`,
      { capability: launch.fragment.slice("#cap=".length) },
    );
    const { credential } = (await exchange.json()) as { credential: string };
    const upgraded = await new Promise<{
      protocol: string | undefined;
      rawHeaders: readonly string[];
      close: Promise<void>;
    }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: `/s/${launch.sessionId}/control`,
        headers: {
          host: `127.0.0.1:${server.port}`,
          origin: server.origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": `placekeeper, placekeeper-auth.${credential}`,
        },
      });
      request.on("upgrade", (response, socket) => {
        resolve({
          protocol: response.headers["sec-websocket-protocol"],
          rawHeaders: response.rawHeaders,
          close: new Promise<void>((closed) => socket.once("close", closed)),
        });
      });
      request.on("error", reject);
      request.end();
    });
    expect(upgraded.protocol).toBe("placekeeper");
    expect(upgraded.rawHeaders.join("\n")).not.toContain(credential);
    await broker.finish(launch.sessionId);
    await upgraded.close;
  });
});
