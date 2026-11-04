import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
const state = vi.hoisted(() => ({ children: [] as ChildProcessWithoutNullStreams[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(() => {
    const child = actual.spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => {});
      process.stdin.on('data', () => { process.stdout.write('malformed\\n'); });
      setInterval(() => {}, 1000);
    `], { stdio: "pipe" });
    state.children.push(child); return child;
  }) };
});
import { closeWindowsNativeWorker, requestWindowsNative } from "../src/platform/windows-native-worker.js";
const realProcess = process;
function simulateWindows(): void {
  vi.stubGlobal("process", new Proxy(realProcess, { get(target, name) { return name === "platform" ? "win32" : Reflect.get(target, name); } }));
  vi.stubEnv("SystemRoot", "/mock-windows");
}
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const child of state.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
  }
  await closeWindowsNativeWorker();
});
it.skipIf(realProcess.platform === "win32")("keeps an uncertain publication fenced until the real worker process closes", async () => {
  simulateWindows(); let settled = false;
  const result = requestWindowsNative({ operation: "publish", candidate: "/tmp/candidate", target: "/tmp/target", replaceExisting: true }).catch((error: unknown) => { settled = true; return error; });
  const child = state.children.at(-1)!;
  await once(child.stdout, "data");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  await expect(requestWindowsNative({ operation: "verify", path: "/tmp/test" })).rejects.toThrow("retiring");
  expect(state.children).toHaveLength(1);
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  expect(await result).toMatchObject({ attempted: true, uncertain: true });
});
it.skipIf(realProcess.platform === "win32")("close waits for process termination rather than releasing pending operations after kill", async () => {
  simulateWindows();
  const operation = requestWindowsNative({ operation: "verify", path: "/tmp/test" }).catch((error: unknown) => error);
  const child = state.children.at(-1)!; await once(child.stdout, "data");
  let closed = false;
  const retiring = Promise.resolve(closeWindowsNativeWorker()).then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve)); expect(closed).toBe(false);
  const exited = once(child, "close"); child.kill("SIGKILL"); await exited; await retiring; await operation;
  expect(closed).toBe(true);
});
