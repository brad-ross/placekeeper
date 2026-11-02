import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readControlDiscovery } from '../../apps/service/src/platform/control-transport.js';
import { MANAGEMENT_PROTOCOL_VERSION, requestControl } from '../../apps/service/src/host/launch-control.js';
import type { ElectronShellBridge } from '../../packages/core/src/electron-shell-protocol.js';
import { InstalledCandidate, candidateExecutable } from './electron-installed-harness.js';
import budget from './electron-performance-budget.json' with { type: 'json' };

declare global { interface Window { placekeeper: ElectronShellBridge } }

const exec = promisify(execFile);
const corpus = [
  { fixture: 'text-native.pdf', kind: 'small-text', maxMs: budget.textFirstUsablePageP95Ms },
  { fixture: 'large-text-heavy.pdf', kind: 'long-text', maxMs: budget.textFirstUsablePageP95Ms },
  { fixture: 'image-only.pdf', kind: 'image', maxMs: budget.imageFirstUsablePageP95Ms },
  { fixture: 'text-native-with-annotations.pdf', kind: 'annotated', maxMs: budget.textFirstUsablePageP95Ms },
] as const;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function candidateResources() {
  const executable = candidateExecutable();
  return process.platform === 'darwin'
    ? resolve(dirname(executable), '../Resources') : join(dirname(executable), 'resources');
}

async function metadata() {
  const executable = candidateExecutable();
  const resources = candidateResources();
  return {
    recordedAt: new Date().toISOString(), executable,
    executableSha256: await sha256(executable),
    applicationAsarSha256: await sha256(join(resources, 'app.asar')),
    runtimeManifestSha256: await sha256(join(resources, 'desktop/runtime-manifest.json')),
    buildEvidenceSha256: await sha256(join(resources, 'desktop/build-evidence.json')),
    hardware: { hostname: hostname(), platform: platform(), release: release(), arch: arch(),
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
    fixtures: await Promise.all(corpus.map(async entry => ({ ...entry,
      sha256: await sha256(resolve('test/fixtures/pdfs', entry.fixture)) }))),
    limitations: [
      'Debuggable packaged release build, CDP automation attached; no AppKit comparison measured by this suite.',
      'Cold means new isolated app profile and stopped daemon; OS filesystem caches are uncontrolled.',
      'Warm means new app process, reused profile and same verified live daemon; it is not a warm in-process open.',
      'Usable-page timing includes CDP observation overhead after process spawn; no main-import-relative timing is substituted.',
      'First visible shell, visible input response, frame intervals, display refresh/DPI, long-recovery and representative scanned corpus remain unmeasured.',
      'Image-only fixture is a reproducible image smoke fixture, not evidence for a large scanned document.',
    ],
  };
}

async function saveReport(info: TestInfo, name: string, report: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

function p95(samples: number[]): number {
  if (!samples.length) throw new Error('No performance samples');
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]!;
}

async function usable(page: Page) {
  await page.locator('[data-production-review][data-initial-view-ready="true"]').waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('img').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    const image = document.querySelector('img');
    if (!image) throw new Error('First page image is missing');
    await image.decode();
    if (!image.complete || !image.naturalWidth) throw new Error('First page image is not decoded');
    await new Promise<void>(accept => requestAnimationFrame(() => requestAnimationFrame(() => accept())));
  });
}

async function daemonPid(candidate: InstalledCandidate): Promise<number> {
  const socket = join(candidate.root, 'control.sock');
  const response = await requestControl(socket, {
    kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'status',
  });
  if (response.kind !== 'management' || response.operation !== 'status') {
    throw new Error('Isolated daemon did not expose its authenticated management status');
  }
  // Discovery is a JSON file only on Windows; on Unix this path is a socket.
  if (process.platform === 'win32') return (await readControlDiscovery(socket)).pid;
  const runtime = join(candidateResources(), 'desktop');
  const node = await realpath(join(runtime, 'node/bin/node'));
  const entry = await realpath(join(runtime, 'service/main.js'));
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const command = new RegExp(`^${escaped(node)} ${escaped(entry)} daemon --isolated-installed-smoke --http-port [1-9][0-9]{0,4} --isolated-test-root ${escaped(candidate.root)}$`);
  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 });
  const matches = stdout.split('\n').flatMap(line => {
    const match = /^\s*([0-9]+)\s+(.+)$/.exec(line);
    return match && command.test(match[2]!) ? [Number(match[1])] : [];
  });
  if (matches.length !== 1) throw new Error(`Expected one packaged daemon for the exact isolated root and runtime, found ${matches.length}`);
  return matches[0]!;
}

test('packaged process spawn to usable page: isolated cold and daemon-warm launches', async ({}, info) => {
  const report = { metadata: await metadata(), budgets: budget, results: [] as Array<{
    fixture: string; condition: string; samplesMs: number[]; p95Ms?: number;
  }> };
  try {
    for (const entry of corpus) {
      const cold = { fixture: entry.fixture, condition: 'app-and-daemon-cold', samplesMs: [] as number[], p95Ms: 0 };
      report.results.push(cold);
      for (let sample = 0; sample < budget.launchSamplesPerCondition; sample++) {
        const candidate = await InstalledCandidate.create(entry.fixture);
        try {
          await usable(await candidate.launch());
          cold.samplesMs.push(performance.now() - candidate.launchStartedAt);
          expect(candidate.errors).toEqual([]);
        } finally { await candidate.dispose(); }
      }
      cold.p95Ms = p95(cold.samplesMs);
      expect.soft(cold.p95Ms, `${entry.fixture}, fully cold`).toBeLessThanOrEqual(entry.maxMs);

      const warm = { fixture: entry.fixture, condition: 'app-cold-daemon-warm', samplesMs: [] as number[], p95Ms: 0 };
      report.results.push(warm);
      const candidate = await InstalledCandidate.create(entry.fixture);
      try {
        await usable(await candidate.launch()); // Unmeasured priming launch.
        const expectedDaemon = await daemonPid(candidate);
        await candidate.stopApp();
        for (let sample = 0; sample < budget.launchSamplesPerCondition; sample++) {
          expect(await daemonPid(candidate), 'Warm daemon identity before launch').toBe(expectedDaemon);
          await usable(await candidate.launch());
          warm.samplesMs.push(performance.now() - candidate.launchStartedAt);
          expect(await daemonPid(candidate), 'Warm daemon was reused').toBe(expectedDaemon);
          expect(candidate.errors).toEqual([]);
          await candidate.stopApp();
        }
      } finally { await candidate.dispose(); }
      warm.p95Ms = p95(warm.samplesMs);
      expect.soft(warm.p95Ms, `${entry.fixture}, daemon warm`).toBeLessThanOrEqual(entry.maxMs);
    }
  } finally { await saveReport(info, 'packaged-launch-performance', report); }
});

type ProcessRow = { pid: number; parent: number; residentKiB: number; cpuSeconds: number };
function cpuSeconds(value: string): number {
  const [daysText, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const fields = clock!.split(':').map(Number);
  return Number(daysText) * 86400 + fields.reduce((sum, field) => sum * 60 + field, 0);
}

async function processes(): Promise<ProcessRow[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, rss, time] = line.trim().split(/\s+/);
    const result = { pid: Number(pid), parent: Number(parent), residentKiB: Number(rss), cpuSeconds: cpuSeconds(time!) };
    if (Object.values(result).some(value => !Number.isFinite(value))) throw new Error(`Unparseable ps row: ${line}`);
    return result;
  });
}

function tree(rows: ProcessRow[], root: number) {
  const ids = new Set([root]);
  let count = 0;
  while (ids.size !== count) {
    count = ids.size;
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
  }
  return rows.filter(row => ids.has(row.pid));
}

async function footprint(appPid: number, servicePid: number) {
  const rows = await processes();
  if (!rows.some(row => row.pid === appPid) || !rows.some(row => row.pid === servicePid)) throw new Error('Measured root process exited');
  const daemon = tree(rows, servicePid);
  const daemonIds = new Set(daemon.map(row => row.pid));
  const electron = tree(rows, appPid).filter(row => !daemonIds.has(row.pid));
  const rss = (group: ProcessRow[]) => group.reduce((sum, row) => sum + row.residentKiB, 0);
  return { atMs: performance.now(), electron, daemon, electronResidentKiB: rss(electron), daemonResidentKiB: rss(daemon),
    combinedResidentKiB: rss(electron) + rss(daemon) };
}

test('macOS isolated packaged idle CPU and twelve normal document close/reopen cycles', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real macOS ps accounting and app-without-windows lifecycle required');
  const report = {
    metadata: await metadata(), budgets: budget,
    accounting: 'Sum of ps RSS in KiB (shared pages can be counted more than once), cumulative user+system CPU time; Electron and daemon descendants partitioned by PID.',
    limitations: ['RSS growth is measured; absence of retained internal document workers/resources is not proven by OS process counts.'],
    postClose: [] as Awaited<ReturnType<typeof footprint>>[],
    idle: [] as Awaited<ReturnType<typeof footprint>>[],
    cpuPercentOfOneCore: undefined as number | undefined,
    postCloseGrowthRatio: undefined as number | undefined,
  };
  const candidate = await InstalledCandidate.create('large-text-heavy.pdf');
  try {
    let page = await candidate.launch();
    await usable(page);
    const app = candidate.appPid;
    if (!app) throw new Error('Packaged app has no process id');
    const daemon = await daemonPid(candidate);
    await delay(budget.memorySettlingMs);
    report.idle.push(await footprint(app, daemon));
    const deadline = performance.now() + budget.idleCpuWindowMs;
    while (performance.now() < deadline) {
      await delay(Math.min(5000, Math.max(1, deadline - performance.now())));
      report.idle.push(await footprint(app, daemon));
    }
    const first = report.idle[0]!;
    const last = report.idle.at(-1)!;
    const inventory = (sample: typeof first) => [...sample.electron, ...sample.daemon].map(row => row.pid).sort((a, b) => a - b);
    for (const sample of report.idle) expect(inventory(sample), 'Stable idle process inventory required for cumulative CPU accounting').toEqual(inventory(first));
    const cpu = (sample: typeof first) => [...sample.electron, ...sample.daemon].reduce((sum, row) => sum + row.cpuSeconds, 0);
    report.cpuPercentOfOneCore = (cpu(last) - cpu(first)) / ((last.atMs - first.atMs) / 1000) * 100;
    expect.soft(report.cpuPercentOfOneCore).toBeLessThan(budget.idleCpuPercentOfOneCoreExclusiveMax);

    for (let cycle = 0; cycle < budget.memoryCloseReopenCycles; cycle++) {
      const closed = page.waitForEvent('close');
      await page.evaluate(async () => {
        const shell = window.placekeeper;
        await shell.requestClose(await shell.identity());
      });
      await closed;
      await delay(budget.memorySettlingMs);
      const status = await requestControl(join(candidate.root, 'control.sock'), {
        kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'status',
      });
      expect(candidate.pages().filter(candidatePage => !candidatePage.isClosed())).toHaveLength(0);
      // macOS keeps one resident app registration after its last window closes.
      // That registration protects service switching; document participants add to it.
      expect(status).toMatchObject({ kind: 'management', operation: 'status', status: { activity: { reviewPresence: 1, codexTasks: 0, transientWork: 0 } } });
      report.postClose.push(await footprint(app, daemon));
      if (cycle + 1 < budget.memoryCloseReopenCycles) {
        await candidate.open(candidate.source);
        await expect.poll(() => candidate.pages().filter(candidatePage => !candidatePage.isClosed()).length).toBe(1);
        page = candidate.pages().find(candidatePage => !candidatePage.isClosed())!;
        await usable(page);
      }
    }
    report.postCloseGrowthRatio = Math.max(...report.postClose.map(sample =>
      sample.combinedResidentKiB / report.postClose[0]!.combinedResidentKiB));
    expect.soft(report.postCloseGrowthRatio).toBeLessThanOrEqual(budget.postCloseResidentGrowthMaxRatio);
  } finally {
    try { await candidate.dispose(); } finally { await saveReport(info, 'packaged-resource-performance', report); }
  }
});
