/** Run: node --import tsx scripts/benchmarks/recovery-scan.ts
 * Local filesystem benchmark; reports medians after one warm-up. */
import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DraftSnapshotStore } from "../../apps/service/src/recovery/draft-snapshot.js";
import { enforceRetention } from "../../apps/service/src/recovery/retention.js";
import { SessionBroker } from "../../apps/service/src/sessions/session-broker.js";
const root = await mkdtemp(join(tmpdir(), "placekeeper-recovery-benchmark-"));
// Baseline models the previous scanner on this fixture (no temporary files,
// no evictions). Keep it here so paired runs face the same filesystem load.
async function baselineAllocatedBytes(path: string): Promise<number> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await readdir(path, { withFileTypes: true }); // abandoned-temp traversal
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith(".tmp")) bytes += (await stat(join(path, entry.name))).size;
  }
  return bytes;
}
async function baselineRetention(): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    await baselineAllocatedBytes(path);
    await stat(path);
  }
}
const sessionCount = 100;
const filesPerSession = 20;
try {
  for (let i = 0; i < sessionCount; i++) {
    const path = join(root, `session-${i}`);
    await mkdir(path);
    for (let file = 0; file < filesPerSession; file++) {
      await writeFile(join(path, `source-${file}.pdf`), Buffer.alloc(128));
    }
  }
  const broker = new SessionBroker({ recoveryRoot: root });
  const store = new DraftSnapshotStore(join(root, "session-0"));
  for (const [name, action] of [
    ["broker.initialize", () => broker.initialize()],
    ["store.initialize x100", async () => { for (let i = 0; i < 100; i++) await store.initialize(); }],
    ["retention", () => enforceRetention(root, new Set(), { maxBytes: Infinity, maxInactiveAgeMs: Infinity })],
  ] as const) {
    await action();
    const samples = [];
    for (let run = 0; run < 7; run++) {
      const start = performance.now();
      await action();
      samples.push(Number((performance.now() - start).toFixed(2)));
    }
    console.log(JSON.stringify({ name, sessionCount, filesPerSession, medianMs: [...samples].sort((a, b) => a - b)[3], samples }));
  }
  const paired: { baseline: number[]; current: number[] } = { baseline: [], current: [] };
  for (let run = 0; run < 8; run++) {
    for (const mode of (run % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"]) as Array<keyof typeof paired>) {
      const start = performance.now();
      if (mode === "baseline") await baselineRetention();
      else await enforceRetention(root, new Set(), { maxBytes: Infinity, maxInactiveAgeMs: Infinity });
      if (run > 0) paired[mode].push(Number((performance.now() - start).toFixed(2)));
    }
  }
  console.log(JSON.stringify({ name: "paired retention", paired, medians: {
    baseline: [...paired.baseline].sort((a, b) => a - b)[3],
    current: [...paired.current].sort((a, b) => a - b)[3],
  } }));
} finally {
  await rm(root, { recursive: true, force: true });
}
