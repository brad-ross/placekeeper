import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseOpenArguments,
  runOpenCommand,
} from "../src/cli/open-command.js";
import {
  requestLaunch,
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { ProofreaderHost } from "../src/host/proofreader-host.js";

const roots: string[] = [];
const hosts: ProofreaderHost[] = [];
const controls: LaunchControlServer[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("open command", () => {
  it("accepts one explicit absolute PDF plus optional approved scope and fork", () => {
    expect(parseOpenArguments([
      "open", "--json", "--pdf", "/tmp/paper.pdf",
      "--source-root", "/tmp/source", "--recovery", "resume", "--surface", "vscode",
    ])).toEqual({
      pdfPath: "/tmp/paper.pdf",
      sourceRootPath: "/tmp/source",
      recovery: "resume",
      surface: "vscode",
    });
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "relative.pdf"]))
      .toThrow("absolute");
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "/a.pdf", "/b.pdf"]))
      .toThrow("one explicit PDF");
  });

  it("prints exactly one structured response and never logs a secret on errors", async () => {
    const write = vi.fn();
    const response = await runOpenCommand(
      ["open", "--json", "--pdf", "/missing.pdf"],
      async () => ({
        ok: false,
        error: {
          kind: "input-unavailable",
          message: "Unavailable",
          recoveryAction: "Choose one readable local PDF",
        },
      }),
      write,
    );
    expect(response).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      ok: false,
      error: {
        kind: "input-unavailable",
        message: "Unavailable",
        recoveryAction: "Choose one readable local PDF",
      },
    });
    expect(write.mock.calls[0]![0]).not.toContain("cap=");
  });

  it("uses a private per-user socket to reach the same persistent broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await ProofreaderHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath);
    controls.push(control);

    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    const opened = await requestLaunch(socketPath, { pdfPath: pdf });
    const focused = await requestLaunch(socketPath, { pdfPath: pdf });
    expect(opened).toMatchObject({ ok: true, kind: "opened" });
    expect(focused).toMatchObject({ ok: true, kind: "focused" });
    if (
      opened.ok && opened.kind !== "recovery-offered" &&
      focused.ok && focused.kind !== "recovery-offered"
    ) expect(focused.sessionId).toBe(opened.sessionId);
  });

  it("carries hook claims, prompt refresh, and task revocation over the same private daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-lifecycle-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath);
    controls.push(control);

    const opened = await requestLaunch(socketPath, { pdfPath: pdf, surface: "codex" });
    if (!opened.ok || opened.kind === "recovery-offered" || opened.bindProof === undefined) {
      throw new Error("Expected a bindable launch");
    }
    expect(await requestControl(socketPath, {
      kind: "claim-binding",
      taskSessionId: "task-a",
      reviewSessionId: opened.sessionId,
      documentGeneration: opened.documentGeneration,
      bindProof: opened.bindProof,
    })).toMatchObject({ kind: "binding", result: { status: "pending" } });
    const capability = new URL(opened.url).hash.slice("#cap=".length);
    expect(host.broker.exchangeBootstrap(opened.sessionId, capability)).toBeTypeOf("string");
    expect(host.broker.taskBindings.bindingForTask("task-a")).toMatchObject({ reviewSessionId: opened.sessionId });

    expect(await requestControl(socketPath, { kind: "refresh-context", taskSessionId: "task-a" }))
      .toMatchObject({ kind: "context" });
    expect(await requestControl(socketPath, { kind: "revoke-task", taskSessionId: "task-a" }))
      .toEqual({ kind: "revoked" });
    expect(host.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
  });
});
