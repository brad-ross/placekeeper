import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { coordinateUpgrade } from "../src/host/upgrade-coordinator.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-codex-daemon-")); roots.push(root);
  const assets = join(root, "assets"); await mkdir(assets);
  await writeFile(join(assets, "app.js"), "export function start(){}\n");
  const pdf = join(root, "review.pdf");
  await writeFile(pdf, "%PDF-1.7\ndaemon lifecycle fixture\n%%EOF");
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), browserSourceRoot: join(root, "browser-sources"), webAssets: { root: assets }, port: 0 });
  hosts.push(host);
  return { host, pdf };
}
async function native(host: PlacekeeperHost, pdf: string) {
  const launch = await host.open({ pdfPath: pdf, surface: "codex-native" });
  if (!launch.ok || !("handoff" in launch)) throw new Error("Expected native launch");
  expect(host.codexRuntime.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: launch.sessionId, documentGeneration: launch.documentGeneration, taskSessionId: "daemon-native-task" })).toBe(true);
  const display = host.codexRuntime.display(launch.handoff.token);
  if (!display) throw new Error("Expected display");
  expect(host.codexRuntime.attestDisplay(display.receipt, "daemon-native-task")).toBe(true);
  const meta = display.privateMeta;
  const active = await host.codexRuntime.pending({ protocolVersion: 1, runtimeId: meta.runtimeId, attemptId: meta.attemptId, requestId: "daemon_request_1234", generation: meta.generation, capability: meta.pendingCapability, authority: "pending", method: "ready", payload: {} });
  if (active.status !== "active") throw new Error("Expected native activation");
  return active;
}
const identity = { daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64) };
function upgrade(host: PlacekeeperHost, mutate: () => Promise<void>) {
  return coordinateUpgrade({ candidate: { ...identity, installArtifactIdentity: "c".repeat(64) }, installed: identity,
    inspect: async () => ({ kind: "exact", status: { protocolVersion: 1, daemonIdentity: identity.daemonIdentity, ...host.lifecycle.status() } }),
    shutdown: () => host.lifecycle.shutdownIfIdle(), waitForRetirement: async () => {}, replaceAndReady: mutate });
}
it("defers a mixed native/browser upgrade until both presentations end, while hints stay advisory", async () => {
  const { host, pdf } = await fixture();
  const active = await native(host, pdf);
  const browser = await host.open({ pdfPath: pdf, surface: "browser" });
  if (!browser.ok || !("url" in browser)) throw new Error("Expected independent browser launch");
  expect(browser.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const browserUrl = new URL(browser.url);
  const exchange = await fetch(`${browserUrl.origin}/s/${browser.sessionId}/exchange`, {
    method: "POST", headers: { origin: browserUrl.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ capability: new URLSearchParams(browserUrl.hash.slice(1)).get("cap") }),
  });
  expect(exchange.status).toBe(200);
  const releaseBrowser = host.broker.controls.registerSocket(browser.sessionId, new PassThrough());
  const mutate = vi.fn(async () => {});
  await expect(upgrade(host, mutate)).rejects.toMatchObject({ reason: "review-presence" });
  await host.codexRuntime.detach(active.runtimeId);
  expect(host.broker.taskBindings.nativeReconnectForTask("daemon-native-task")).toBeDefined();
  expect(host.broker.taskBindings.bindingForTask("daemon-native-task")).toBeUndefined();
  await expect(upgrade(host, mutate)).rejects.toMatchObject({ reason: "review-presence" });
  expect(mutate).not.toHaveBeenCalled();
  releaseBrowser();
  // Explicit control retirement removes the browser disconnect grace; the
  // advisory native reconnect hint remains and cannot block replacement.
  host.broker.controls.closeAllSockets();
  expect(host.lifecycle.status().activity).toEqual({ reviewPresence: 0, codexTasks: 0, transientWork: 0 });
  await expect(upgrade(host, mutate)).resolves.toEqual({ status: "installed" });
  expect(mutate).toHaveBeenCalledOnce();
});
it("cancels an idle upgrade drain when a fresh native admission races the final idle check", async () => {
  const { host, pdf } = await fixture();
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const drain = host.broker.drainWrites.bind(host.broker);
  vi.spyOn(host.broker, "drainWrites").mockImplementationOnce(async () => { entered.resolve(); await resume.promise; await drain(); });
  const mutate = vi.fn(async () => {});
  const replacing = upgrade(host, mutate);
  await entered.promise;
  const active = await native(host, pdf);
  resume.resolve();
  await expect(replacing).rejects.toMatchObject({ reason: "review-presence" });
  expect(host.lifecycle.status().lifecycle).toBe("accepting");
  expect(mutate).not.toHaveBeenCalled();
  await host.codexRuntime.detach(active.runtimeId);
});

it.each(['closed', 'disposed'])('serves an ordinary browser review with the native runtime %s', async (runtimeState) => {
  const { host, pdf } = await fixture();
  // Runtime teardown does not establish plugin enablement or registration state.
  if (runtimeState === 'closed') await host.codexRuntime.close();
  else host.codexRuntime.dispose();
  const launch = await host.open({ pdfPath: pdf, surface: 'browser' });
  if (!launch.ok || !('url' in launch)) throw new Error('Expected browser launch');
  const response = await fetch(launch.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('location.replace(view.pathname');
  const url = new URL(launch.url);
  const capability = new URLSearchParams(url.hash.slice(1)).get('cap');
  const exchanged = await fetch(`${url.origin}/s/${launch.sessionId}/exchange`, {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ capability }),
  });
  expect(exchanged.status).toBe(200);
  const { credential, view } = await exchanged.json() as { credential: string; view: { pathname: string } };
  expect((await fetch(`${url.origin}${view.pathname}`)).status).toBe(200);
  await expect((await fetch(`${url.origin}/s/${launch.sessionId}/scope`, { headers: { authorization: `Bearer ${credential}` } })).json()).resolves.toMatchObject({ launchSurface: 'browser' });
  expect(host.broker.taskBindings.activityCount()).toBe(0);
});
