import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopIsolatedRoot } from '../support/desktop-isolated-root.js';
import { chromium, type Browser, type Page } from '@playwright/test';
import { requestControl, MANAGEMENT_PROTOCOL_VERSION } from '../../apps/service/src/host/launch-control.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

export function candidateExecutable(): string {
  if (process.env.PLACEKEEPER_TEST_EXECUTABLE) return resolve(process.env.PLACEKEEPER_TEST_EXECUTABLE);
  const directory = resolve(`dist/desktop-artifacts/Placekeeper Candidate-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? join(directory, 'Placekeeper Candidate.app/Contents/MacOS/PlacekeeperCandidate')
    : join(directory, process.platform === 'win32' ? 'PlacekeeperCandidate.exe' : 'PlacekeeperCandidate');
}

export class InstalledCandidate {
  private browser?: Browser;
  private child?: ChildProcess;
  private closed?: Promise<void>;
  private log = '';
  private servicePort?: number;
  launchStartedAt = 0;
  get appPid(): number | undefined { return this.child?.pid; }
  private launchArgs: string[] = [];
  private launchEnvironment: NodeJS.ProcessEnv = {};
  readonly errors: string[] = [];
  private constructor(readonly root: string, readonly source: string) {}

  static async create(fixture = 'legible-link-destinations.pdf'): Promise<InstalledCandidate> {
    const root = await createDesktopIsolatedRoot();
    const source = join(root, 'Review with spaces.pdf');
    await copyFile(resolve('test/fixtures/pdfs', fixture), source);
    return new InstalledCandidate(root, source);
  }

  async launch(): Promise<Page> {
    const debugPort = await freePort();
    const servicePort = this.servicePort ??= await freePort();
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH' || key.startsWith('PLACEKEEPER_') || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key];
    }
    env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
    this.launchArgs = [
      '--isolated-installed-smoke', '--http-port', String(servicePort), '--isolated-test-root', this.root,
    ];
    this.launchEnvironment = env;
    this.log = '';
    this.launchStartedAt = performance.now();
    this.child = spawn(candidateExecutable(), [...this.launchArgs, `--remote-debugging-port=${debugPort}`, this.source],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.closed = new Promise(accept => this.child!.once('exit', () => accept()));
    this.child.stdout!.on('data', data => { this.log += String(data); });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`No candidate debugging endpoint: ${this.log}`)), 30_000);
      this.child!.once('error', error => { clearTimeout(timer); reject(error); });
      this.child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Candidate exited ${code}: ${this.log}`)); });
      this.child!.stderr!.on('data', data => {
        this.log += String(data);
        if (this.log.includes('DevTools listening on')) { clearTimeout(timer); accept(); }
      });
    });
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    // Keep this observer separate from page admission: it must not wait for or
    // change the existing first-context/page selection while diagnosing startup.
    const browser = this.browser;
    const startupEvents: unknown[] = [];
    const recordStartup = (event: string, detail?: unknown) => {
      if (startupEvents.length < 128) startupEvents.push({ event, atMs: performance.now() - this.launchStartedAt, detail });
    };
    const contextInventory = () => browser.contexts().map((context, index) => ({ index,
      pages: context.pages().map(page => ({ url: page.url(), closed: page.isClosed() })),
    }));
    recordStartup('connected', { connected: browser.isConnected(), contexts: contextInventory() });
    const disconnected = () => recordStartup('disconnected');
    browser.on('disconnected', disconnected);
    let observer: Awaited<ReturnType<Browser['newBrowserCDPSession']>> | undefined;
    void browser.newBrowserCDPSession().then(async session => {
      observer = session;
      for (const event of ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed', 'Target.targetCrashed'] as const) {
        session.on(event, detail => recordStartup(event, detail));
      }
      await session.send('Target.setDiscoverTargets', { discover: true });
    }).catch(error => recordStartup('observer-failed', String(error)));
    const startupFailure = async () => {
      let targets: unknown;
      try {
        targets = await Promise.race([
          observer?.send('Target.getTargets') ?? Promise.resolve('CDP observer not established'),
          delay(1000).then(() => 'CDP target inventory timed out'),
        ]);
      } catch (error) { targets = String(error); }
      this.log += `\n[candidate-startup-diagnostic] ${JSON.stringify({
        connected: browser.isConnected(), contexts: contextInventory(), selectedContextIndex: 0,
        targets, events: startupEvents,
      })}\n`;
    };
    const context = browser.contexts()[0]!;
    const page = await new Promise<Page>((accept, reject) => {
      const timer = setTimeout(() => {
        context.off('page', watch);
        void startupFailure().catch(error => {
          this.log += `\n[candidate-startup-diagnostic-error] ${String(error)}\n`;
        }).then(() => {
          reject(new Error(`No packaged review page. Targets: ${JSON.stringify(this.pages().map(page => ({ url: page.url(), closed: page.isClosed() })))}\n${this.log}`));
        });
      }, 30_000);
      const watch = (candidate: Page) => {
        recordStartup('page-observed', { url: candidate.url(), contextIndex: browser.contexts().indexOf(candidate.context()) });
        candidate.once('close', () => recordStartup('page-closed', { url: candidate.url() }));
        candidate.once('crash', () => recordStartup('page-crashed', { url: candidate.url() }));
        candidate.on('pageerror', error => recordStartup('page-error', String(error)));
        candidate.on('dialog', dialog => {
          if (dialog.type() !== 'beforeunload') this.errors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`);
          void dialog.dismiss().catch(error => {
            if (!String(error).includes('No dialog is showing')) this.errors.push(String(error));
          });
        });
        void candidate.waitForURL('placekeeper-app://bundle/electron.html', { timeout: 30_000 }).then(() => {
          clearTimeout(timer);
          context.off('page', watch);
          accept(candidate);
        }).catch(error => recordStartup('page-url-wait-failed', { url: candidate.url(), error: String(error) }));
      };
      context.on('page', watch);
      for (const candidate of context.pages()) watch(candidate);
    });
    page.on('pageerror', error => this.errors.push(String(error)));
    page.on('requestfailed', request => this.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.setDefaultTimeout(10_000);
    await page.waitForLoadState('domcontentloaded');
    browser.off('disconnected', disconnected);
    if (observer) void observer.detach().catch(() => undefined);
    return page;
  }

  pages(): Page[] { return this.browser?.contexts().flatMap(context => context.pages()) ?? []; }

  async open(source: string): Promise<void> { return this.openArguments([source]); }

  async openLaunch(launchId: string): Promise<void> { return this.openArguments(['--placekeeper-launch', launchId]); }

  private async openArguments(args: readonly string[]): Promise<void> {
    const child = spawn(candidateExecutable(), [...this.launchArgs, ...args], { env: this.launchEnvironment, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Second invocation did not hand off: ${output}`)); }, 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`Second invocation exited ${code}: ${output}`)); });
    });
  }

  timings(): Array<{ stage: string; elapsedMs: number; windowId?: string; attemptId?: string }> {
    return this.log.split('\n').flatMap(line => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value.type === 'electron-timing' && typeof value.stage === 'string' && typeof value.elapsedMs === 'number'
          ? [value as { stage: string; elapsedMs: number; windowId?: string; attemptId?: string }] : [];
      } catch { return []; }
    });
  }

  async stopApp(): Promise<void> {
    await Promise.race([this.browser?.close(), delay(1500)]);
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([this.closed, delay(5000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
        await this.closed;
      }
    }
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    delete this.browser;
    await writeFile(join(this.root, 'process.log'), this.log);
  }

  async dispose(): Promise<void> {
    try {
      await this.stopApp();
      // The lifecycle helper drains after its parent exits; only retire this test's isolated daemon.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const response = await requestControl(join(this.root, 'control.sock'), {
            kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'shutdown-if-idle',
          }, { timeoutMs: 2000 });
          if (response.kind === 'management' && response.operation === 'shutdown-if-idle' && response.result.status === 'accepted') return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return;
          if (attempt === 19) throw error;
        }
        await delay(250);
      }
      throw new Error(`Isolated candidate daemon did not become idle: ${this.root}`);
    } finally {
      await writeFile(join(this.root, 'process.log'), this.log);
    }
  }
}
