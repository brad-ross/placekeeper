import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { runContextCommand } from "../src/cli/context-command.js";
import {
  CODEX_INSTALLED_LAUNCHER_COMMAND,
  runHookCommand,
} from "../src/cli/hook-command.js";
import {
  requestControl,
  requestLaunch,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { ProofreaderHost } from "../src/host/proofreader-host.js";

const roots: string[] = [];
const hosts: ProofreaderHost[] = [];
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

describe("packaged Codex live-context lifecycle", () => {
  it("binds the exact launch, activates in the browser, refreshes deltas, gates evidence, and revokes at task end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-codex-acceptance-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
    const host = await ProofreaderHost.start({
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
    const { credential } = await exchanged.json() as { credential: string };

    const firstWrite = vi.fn();
    await runHookCommand(["hook", "--event"], hookInput("UserPromptSubmit"), control, firstWrite);
    const first = injectedContext(firstWrite);
    expect(first).toMatchObject({
      currentness: "current",
      document: { generation: launch.documentGeneration, reviewRevision: 0 },
      reviewItems: { mode: "full", itemCount: 0, completeItems: "retrieve" },
      existingPdfAnnotations: { count: 2 },
      evidence: { handle: expect.stringMatching(/^evidence_/u) },
    });
    expect(JSON.stringify(first)).not.toMatch(/127\.0\.0\.1|cap=|bindProof|\/private\/|codex-task/u);

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
        mode: "full",
        reason: "unknown-cursor",
        itemCount: 1,
        completeItems: "retrieve",
      },
    });
    const handle = delta.evidence.handle as string;
    const itemsWrite = vi.fn();
    expect(await runContextCommand(["context", "items", "--handle", handle], control, itemsWrite)).toBe(0);
    const itemsOutput = JSON.parse(itemsWrite.mock.calls[0]![0] as string) as { content: string };
    expect(JSON.parse(itemsOutput.content)).toMatchObject({
      total: 1,
      items: [{ intent: "pageNote", pageIndex: 0, anchor: { nearbyText: "Nearby PDF text." } }],
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
