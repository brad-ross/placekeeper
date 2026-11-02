import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, it } from "vitest";
import { EditorProfiles } from "../src/synctex/editor-profiles.js";
import { dispatchEditorLocation } from "../src/synctex/editor-dispatch.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pk-editor-")); roots.push(root);
  const profiles = new EditorProfiles(join(root, "profiles.json"));
  return { root, profiles };
}

describe("trusted editor return destinations", () => {
  it("persists profiles but captures immutable, process-local registrations", async () => {
    const { root, profiles } = await fixture();
    await profiles.add({ name: "code", kind: "command", executable: process.execPath, args: ["{file}"] });
    const registration = await profiles.register({ profile: "code", sourceRoot: root });
    await profiles.add({ name: "code", kind: "command", executable: process.execPath, args: ["--new", "{file}"] });
    expect(registration.profile).toMatchObject({ args: ["{file}"] });
    const restarted = new EditorProfiles(join(root, "profiles.json"));
    expect(await restarted.list()).toMatchObject([{ name: "code", args: ["--new", "{file}"] }]);
    expect(restarted.registration(registration.handle)).toBeUndefined();
  });

  it("passes source characters literally as argv without shell evaluation", async () => {
    const { root, profiles } = await fixture();
    const source = "-chapter ' \" $() `touch nope` ; ü\n.tex";
    await writeFile(join(root, source), "source");
    const capture = join(root, "captured.json");
    const script = join(root, "capture.mjs");
    await writeFile(script, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');
    await profiles.add({ name: "fixture", kind: "command", executable: process.execPath,
      args: [script, capture, "{file}", "{line}", "{column}"] });
    const registration = await profiles.register({ profile: "fixture", sourceRoot: root });
    expect(await dispatchEditorLocation(registration, { path: source, line: 7, column: 3 })).toEqual({ status: "opened" });
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual([join(registration.sourceRoot, source), "7", "3"]);
  });

  it("rejects invalid templates, missing executables, and escaping source targets", async () => {
    const { root, profiles } = await fixture();
    await expect(profiles.add({ name: "bad", kind: "command", executable: process.execPath, args: ["{unknown}"] })).rejects.toThrow();
    await expect(profiles.add({ name: "missing", kind: "command", executable: join(root, "missing"), args: ["{file}"] })).rejects.toThrow();
    await profiles.add({ name: "fixture", kind: "command", executable: process.execPath, args: ["{file}"] });
    const registration = await profiles.register({ profile: "fixture", sourceRoot: root });
    expect(await dispatchEditorLocation(registration, { path: "../escape.tex", line: 1 })).toMatchObject({ status: "failed", reason: "source-unavailable" });
  });

  it("does not dispatch when the association was replaced during source resolution", async () => {
    const { root, profiles } = await fixture();
    await writeFile(join(root, "paper.tex"), "source");
    await profiles.add({ name: "fixture", kind: "command", executable: process.execPath, args: ["{file}"] });
    const registration = await profiles.register({ profile: "fixture", sourceRoot: root });
    expect(await dispatchEditorLocation(registration, { path: "paper.tex", line: 1 }, { isCurrent: () => false }))
      .toEqual({ status: "stale", reason: "editor-association-changed" });
  });

  it("reports a failed editor command without choosing another destination", async () => {
    const { root, profiles } = await fixture();
    await writeFile(join(root, "paper.tex"), "source");
    const script = join(root, "fail.mjs"); await writeFile(script, "process.exit(7);");
    await profiles.add({ name: "fixture", kind: "command", executable: process.execPath, args: [script, "{file}"] });
    const registration = await profiles.register({ profile: "fixture", sourceRoot: root });
    expect(await dispatchEditorLocation(registration, { path: "paper.tex", line: 1 }))
      .toEqual({ status: "failed", reason: "editor-exited-7" });
  });

  it("sends structured source data to only the registered Neovim socket", async () => {
    const { root, profiles } = await fixture();
    const source = "chapter '$(echo x)'.tex";
    await writeFile(join(root, source), "source");
    const received: unknown[] = [];
    const socketPath = join(root, "nvim.sock");
    const server = createServer(socket => {
      void (async () => {
        for await (const frame of decodeMultiStream(socket)) {
          received.push(frame);
          const message = frame as unknown[];
          socket.write(encode([1, message[1], null, true]));
        }
      })().catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      await profiles.add({ name: "nvim", kind: "neovim" });
      const registration = await profiles.register({ profile: "nvim", sourceRoot: root, socket: socketPath });
      expect(await dispatchEditorLocation(registration, { path: source, line: 7, column: 3 })).toEqual({ status: "opened" });
      expect(received).toHaveLength(1);
      const frame = received[0] as unknown[];
      expect(frame.slice(0, 3)).toEqual([0, 1, "nvim_exec_lua"]);
      const args = frame[3] as unknown[];
      expect(args[0]).not.toContain(source);
      expect(args[1]).toEqual([join(registration.sourceRoot, source), 7, 3]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("rejects paths that cannot use a compound editor location argument", async () => {
    const { root, profiles } = await fixture();
    await writeFile(join(root, "part:one.tex"), "source");
    await profiles.add({ name: "fixture", kind: "command", executable: process.execPath, args: ["{file}:{line}"] });
    const registration = await profiles.register({ profile: "fixture", sourceRoot: root });
    expect(await dispatchEditorLocation(registration, { path: "part:one.tex", line: 1 }))
      .toEqual({ status: "failed", reason: "unsupported-editor-location-path" });
  });

  it.each(["fragmented", "oversized", "silent", "removed"] as const)("handles a %s Neovim endpoint", async mode => {
    const { root, profiles } = await fixture();
    await writeFile(join(root, "paper.tex"), "source");
    const socketPath = join(root, "nvim.sock");
    const server = createServer(socket => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        if (mode === "oversized") socket.end(encode([1, 1, null, "x".repeat(70_000)]));
        if (mode === "fragmented") {
          const response = encode([1, 1, null, true]);
          socket.write(response.slice(0, 2));
          setTimeout(() => socket.end(response.slice(2)), 10);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await profiles.add({ name: "nvim", kind: "neovim" });
    const registration = await profiles.register({ profile: "nvim", sourceRoot: root, socket: socketPath });
    if (mode === "removed") await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      const result = await dispatchEditorLocation(registration, { path: "paper.tex", line: 1 }, { timeoutMs: 250 });
      expect(result).toEqual(mode === "fragmented" ? { status: "opened" } : { status: "failed", reason:
        mode === "oversized" ? "invalid-editor-response" : mode === "silent" ? "editor-timeout" : "neovim-session-unavailable" });
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

});
