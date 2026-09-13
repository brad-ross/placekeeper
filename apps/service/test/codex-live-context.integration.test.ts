import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";
import { runContextCommand } from "../src/cli/context-command.js";
import {
  CODEX_INSTALLED_LAUNCHER_COMMAND,
  runHookCommand,
} from "../src/cli/hook-command.js";
import {
  requestControl,
  requestLaunch,
  requestLinkOpen,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];
const controls: LaunchControlServer[] = [];
const taskSessionId = "codex-task-acceptance";

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hookInput(
  hookEventName: "PostToolUse" | "UserPromptSubmit" | "SessionEnd",
  launch?: Awaited<ReturnType<typeof requestLaunch>>,
): string {
  if (hookEventName === "PostToolUse") {
    if (launch === undefined || !launch.ok || launch.kind === "recovery-offered") {
      throw new Error("A successful launch is required");
    }
    return JSON.stringify({
      session_id: taskSessionId,
      hook_event_name: hookEventName,
      tool_name: "Bash",
      tool_input: {
        command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf /private/tmp/acceptance.pdf`,
      },
      tool_response: JSON.stringify(launch),
    });
  }
  return JSON.stringify({
    session_id: taskSessionId,
    hook_event_name: hookEventName,
    ...(hookEventName === "UserPromptSubmit" ? { prompt: "Summarize my PDF notes." } : {}),
  });
}

function injectedContext(write: ReturnType<typeof vi.fn>): Record<string, any> {
  const output = JSON.parse(write.mock.calls.at(-1)![0] as string) as {
    hookSpecificOutput: { additionalContext: string };
  };
  return JSON.parse(output.hookSpecificOutput.additionalContext) as Record<string, any>;
}

function postJson(url: string, body: unknown, cookie?: string): Promise<Response> {
  const origin = new URL(url).origin;
  return fetch(url, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

describe("packaged Codex live-context lifecycle", () => {
  it("reattaches an interrupted Codex review on the owning task's next prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-codex-restart-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "restart-linked.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);

    const first = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
      port: 0,
    });
    hosts.push(first);
    const firstSocket = join(root, "first-control.sock");
    controls.push(await startLaunchControlServer(first, firstSocket));
    const firstControl = (request: Parameters<typeof requestControl>[1]) =>
      requestControl(firstSocket, request);
    const launched = await requestLaunch(firstSocket, { pdfPath: pdf, surface: "codex" });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.bindProof === undefined) {
      throw new Error("Expected an initial Codex launch");
    }
    await runHookCommand(
      ["hook", "--event"],
      hookInput("PostToolUse", launched),
      firstControl,
      vi.fn(),
    );

    const launchedUrl = new URL(launched.url);
    const capability = new URLSearchParams(launchedUrl.hash.slice(1)).get("cap");
    const exchange = await postJson(
      `${launchedUrl.origin}/s/${launched.sessionId}/exchange`,
      { capability },
    );
    expect(exchange.status).toBe(200);
    const reconnectCookie = /(?:^|,\s*)(placekeeper_reconnect=[^;]+)/u
      .exec(exchange.headers.get("set-cookie") ?? "")?.[1];
    expect(reconnectCookie).toBeDefined();
    const firstView = await exchange.json() as {
      credential: string;
      view: { id: string; pathname: string; locationFragment: string };
    };

    const port = first.server.port;
    await first.server.close();
    hosts.splice(hosts.indexOf(first), 1);
    const successor = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
      port,
    });
    hosts.push(successor);
    const successorSocket = join(root, "successor-control.sock");
    controls.push(await startLaunchControlServer(successor, successorSocket));
    const successorControl = (request: Parameters<typeof requestControl>[1]) =>
      requestControl(successorSocket, request);

    const stale = await fetch(`${successor.server.origin}${firstView.view.pathname}`, {
      headers: { cookie: reconnectCookie! },
    });
    expect(await stale.text()).toContain("This session is no longer available.");
    const link = encodePlacekeeperLink({ path: pdf, location: { kind: "page", page: 2 } });
    const unboundReopen = await postJson(
      `${successor.server.origin}/r/${firstView.view.id}/reopen`,
      { link, confirmed: true },
    );
    const unboundResult = await unboundReopen.json() as {
      ok: true;
      url: string;
      reconnectPending?: boolean;
    };
    expect(unboundResult).not.toHaveProperty("reconnectPending");
    const unboundUrl = new URL(unboundResult.url);
    const unboundSessionId = /^\/s\/([^/]+)\/bootstrap$/u.exec(unboundUrl.pathname)?.[1];
    const unboundCapability = new URLSearchParams(unboundUrl.hash.slice(1)).get("cap");
    const unboundExchange = await postJson(
      `${successor.server.origin}/s/${unboundSessionId}/exchange`,
      { capability: unboundCapability },
    );
    const unboundView = await unboundExchange.json() as { credential: string };
    const unboundOwnerWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), successorControl, unboundOwnerWrite);
    expect(injectedContext(unboundOwnerWrite)).toMatchObject({ currentness: "unavailable" });
    await expect((await fetch(`${successor.server.origin}/s/${unboundSessionId}/scope`, {
      headers: { authorization: `Bearer ${unboundView.credential}` },
    })).json()).resolves.toMatchObject({ launchSurface: "browser" });

    const reopened = await postJson(
      `${successor.server.origin}/r/${firstView.view.id}/reopen`,
      { link, confirmed: true },
      reconnectCookie,
    );
    expect(reopened.status).toBe(200);
    const reopenedResult = await reopened.json() as {
      ok: true;
      kind: "opened" | "focused";
      url: string;
      reconnectPending?: boolean;
    };
    expect(reopenedResult).toMatchObject({ reconnectPending: true });
    expect(reopenedResult).not.toHaveProperty("bindProof");
    const reopenedUrl = new URL(reopenedResult.url);
    const reopenedCapability = new URLSearchParams(reopenedUrl.hash.slice(1)).get("cap");
    const reopenedSessionId = /^\/s\/([^/]+)\/bootstrap$/u.exec(reopenedUrl.pathname)?.[1];
    expect(reopenedSessionId).toBeDefined();
    const foreignWrite = vi.fn();
    await runHookCommand(["hook", "--event"], JSON.stringify({
      session_id: "another-codex-task",
      hook_event_name: "UserPromptSubmit",
      prompt: "Check context.",
    }), successorControl, foreignWrite);
    expect(injectedContext(foreignWrite)).toMatchObject({ currentness: "unavailable" });

    const ownerWrite = vi.fn();
    // The task prompt can win the race with the browser bootstrap; it must
    // wait for the matching capability rather than report unavailable.
    const ownerPrompt = runHookCommand(
      ["hook", "--event"],
      hookInput("UserPromptSubmit"),
      successorControl,
      ownerWrite,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reopenedExchange = await postJson(
      `${successor.server.origin}/s/${reopenedSessionId}/exchange`,
      { capability: reopenedCapability },
    );
    const reopenedView = await reopenedExchange.json() as {
      credential: string;
      view: { pathname: string };
    };
    await ownerPrompt;
    const promotedScope = await fetch(
      `${successor.server.origin}/s/${reopenedSessionId}/scope`,
      { headers: { authorization: `Bearer ${reopenedView.credential}` } },
    );
    expect(promotedScope.status).toBe(200);
    const promotedScopeBody = await promotedScope.json() as Record<string, unknown>;
    expect(promotedScopeBody).toMatchObject({ launchSurface: "codex" });
    expect(promotedScopeBody).not.toHaveProperty("reconnectPending");
    expect(injectedContext(ownerWrite)).toMatchObject({
      currentness: "current",
      reviewItems: { mode: "full" },
    });
    await expect((await fetch(`${successor.server.origin}/s/${reopenedSessionId}/scope`, {
      headers: { authorization: `Bearer ${reopenedView.credential}` },
    })).json()).resolves.toMatchObject({
      launchSurface: "codex",
      codexContext: { status: expect.stringMatching(/^(?:current|refreshing)$/u) },
    });
  });

  it("rebinds a canonical Placekeeper link opened explicitly through Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-codex-link-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "linked.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
    const host = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const control = (request: Parameters<typeof requestControl>[1]) => requestControl(socketPath, request);
    const link = encodePlacekeeperLink({ path: pdf, location: { kind: "page", page: 2 } });
    const launch = await requestLinkOpen(socketPath, {
      link,
      confirmed: true,
      surface: "codex",
    });
    if (
      !launch.ok || launch.kind === "recovery-offered" ||
      launch.kind === "confirmation-required" || launch.bindProof === undefined
    ) throw new Error("Expected a task-bindable linked launch");

    await runHookCommand(["hook", "--event"], JSON.stringify({
      session_id: taskSessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open-link --json --surface codex --confirmed --link '${link}'`,
      },
      tool_response: JSON.stringify(launch),
    }), control, vi.fn());

    const launchedUrl = new URL(launch.url);
    const capability = new URLSearchParams(launchedUrl.hash.slice(1)).get("cap");
    const exchanged = await fetch(`${launchedUrl.origin}/s/${launch.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launchedUrl.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    expect(exchanged.status).toBe(200);

    const write = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, write);
    expect(injectedContext(write)).toMatchObject({
      currentness: "current",
      reviewItems: { mode: "full" },
    });
  });

  it("binds the exact launch, activates in the browser, refreshes deltas, gates evidence, and revokes at task end", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-codex-acceptance-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
    const host = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const controlServer = await startLaunchControlServer(host, socketPath);
    controls.push(controlServer);
    const control = (request: Parameters<typeof requestControl>[1]) => requestControl(socketPath, request);

    const launch = await requestLaunch(socketPath, { pdfPath: pdf, surface: "codex" });
    if (!launch.ok || launch.kind === "recovery-offered" || launch.bindProof === undefined) {
      throw new Error("Expected a task-bindable Codex launch");
    }

    const beforeActivation = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, beforeActivation);
    expect(injectedContext(beforeActivation)).toMatchObject({ currentness: "unavailable", reason: "unbound" });

    await runHookCommand(["hook", "--event"], hookInput("PostToolUse", launch), control, vi.fn());
    expect(await requestControl(socketPath, {
      kind: "claim-binding",
      taskSessionId: "second-codex-task",
      reviewSessionId: launch.sessionId,
      documentGeneration: launch.documentGeneration,
      bindProof: launch.bindProof,
    })).toMatchObject({ kind: "binding", result: { status: "denied" } });

    const launchedUrl = new URL(launch.url);
    const capability = new URLSearchParams(launchedUrl.hash.slice(1)).get("cap");
    const exchanged = await fetch(`${launchedUrl.origin}/s/${launch.sessionId}/exchange`, {
      method: "POST",
      headers: {
        origin: launchedUrl.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    expect(exchanged.status).toBe(200);
    const { credential, view } = await exchanged.json() as {
      credential: string;
      view: { id: string; pathname: string; locationFragment: string };
    };
    const viewCookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
    expect(viewCookie).toMatch(/^placekeeper_view=/u);
    expect(view.locationFragment).toBe("v=1&page=1");
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const resumed = await fetch(`${launchedUrl.origin}/r/${view.id}/resume`, {
        method: "POST",
        headers: {
          origin: launchedUrl.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          cookie: viewCookie!,
        },
        body: JSON.stringify({ pathname: view.pathname }),
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({
        sessionId: launch.sessionId,
        credential,
        appLinkBase: expect.stringMatching(/^placekeeper:\/\/\/.+paper\.pdf$/u),
      });
    }
    const resumedScope = await fetch(`${launchedUrl.origin}/s/${launch.sessionId}/scope`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(resumedScope.status).toBe(200);
    expect(await resumedScope.json()).toMatchObject({
      launchSurface: "codex",
      codexContext: { status: expect.stringMatching(/^(?:current|refreshing)$/u) },
    });

    const firstWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, firstWrite);
    const first = injectedContext(firstWrite);
    expect(first).toMatchObject({
      currentness: "current",
      document: { generation: launch.documentGeneration, reviewRevision: 0 },
      reviewItems: { mode: "full", itemCount: 2, completeItems: "retrieve" },
      existingPdfAnnotations: { count: 0 },
      evidence: { handle: expect.stringMatching(/^evidence_/u) },
    });
    expect(JSON.stringify(first)).not.toMatch(/127\.0\.0\.1|cap=|bindProof|\/private\/|codex-task/u);

    const unchangedWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, unchangedWrite);
    expect(injectedContext(unchangedWrite)).toMatchObject({
      currentness: "current",
      reviewItems: { mode: "unchanged", itemCount: 2 },
    });

    const state = host.broker.state(launch.sessionId);
    if (state === undefined) throw new Error("Expected current review state");
    const command = addPageNote(
      state,
      0,
      { x: 72, y: 80, width: 18, height: 18 },
      "Check this argument.",
      {
        createId: () => "00000000-0000-4000-8000-000000000801",
        now: () => "2026-08-12T12:00:00.000Z",
      },
      "Nearby PDF text.",
    );
    const mutated = await fetch(`${launchedUrl.origin}/s/${launch.sessionId}/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        origin: launchedUrl.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(command),
    });
    expect(mutated.status).toBe(200);

    const deltaWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, deltaWrite);
    const delta = injectedContext(deltaWrite);
    expect(delta).toMatchObject({
      currentness: "current",
      document: { reviewRevision: 1 },
      reviewItems: {
        mode: "delta",
        itemCount: 3,
        added: [{ intent: "pageNote", pageIndex: 0 }],
      },
    });
    const handle = delta.evidence.handle as string;
    expect(await requestControl(socketPath, {
      kind: "source-begin",
      handle: "evidence_not_authorized_abcdefghijklmnop",
    })).toEqual({ kind: "source-workflow-unavailable", reason: "unauthorized" });
    const itemsWrite = vi.fn();
    expect(await runContextCommand(["context", "items", "--handle", handle], control, itemsWrite)).toBe(0);
    const itemsOutput = JSON.parse(itemsWrite.mock.calls[0]![0] as string) as { content: string };
    expect(JSON.parse(itemsOutput.content)).toMatchObject({
      total: 3,
      items: expect.arrayContaining([
        expect.objectContaining({ intent: "pageNote", pageIndex: 0, anchor: expect.objectContaining({ nearbyText: "Nearby PDF text." }) }),
      ]),
    });
    const changesWrite = vi.fn();
    expect(await runContextCommand(["context", "changes", "--handle", handle], control, changesWrite)).toBe(0);
    const changesOutput = JSON.parse(changesWrite.mock.calls[0]![0] as string) as { content: string };
    expect(JSON.parse(changesOutput.content)).toMatchObject({
      mode: "delta",
      total: 1,
      changes: [{ change: "added", item: { intent: "pageNote" } }],
    });

    const evidenceWrite = vi.fn();
    expect(await runContextCommand([
      "context", "evidence", "--handle", handle, "--kind", "page-text", "--page", "0", "--max-bytes", "65536",
    ], control, evidenceWrite)).toBe(0);
    expect(JSON.parse(evidenceWrite.mock.calls[0]![0] as string)).toMatchObject({ ok: true, kind: "page-text" });
    expect(await requestControl(socketPath, {
      kind: "retrieve-evidence",
      taskSessionId: "second-codex-task",
      handle,
      request: { kind: "page-text", pageIndex: 0, maxBytes: 65_536 },
    })).toMatchObject({ kind: "evidence", result: { status: "unavailable", reason: "unauthorized" } });

    await runHookCommand(["hook", "--event"], hookInput("SessionEnd"), control, vi.fn());
    const endedWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, endedWrite);
    expect(injectedContext(endedWrite)).toMatchObject({ currentness: "unavailable", reason: "unbound" });
    expect(await requestControl(socketPath, {
      kind: "retrieve-evidence-by-handle",
      handle,
      request: { kind: "page-text", pageIndex: 0, maxBytes: 65_536 },
    })).toMatchObject({ kind: "evidence", result: { status: "unavailable", reason: "unauthorized" } });
  });
});
