import {
  parseNativeAppControlMessage,
  type NativeAppControlMessage,
  type NativeAppControlResponse,
} from "../../../../packages/core/src/native-app-control-protocol.js";

interface RuntimeDetacher {
  detach(helperId: string): Promise<void>;
}

interface AppRecord {
  readonly appInstanceId: string;
  readonly processId: number;
  readonly startIdentity: string;
  readonly buildIdentity: string;
  readonly helpers: Set<string>;
  readonly retiredHelpers: Set<string>;
  readonly pendingHelpers: Map<string, Promise<void>>;
  retiring: boolean;
  retirement?: Promise<void>;
  activeWindows: number;
  bootstrappingWindows: number;
}

export class NativeAppLifecycleManager {
  readonly #runtime: RuntimeDetacher;
  readonly #probeProcess: (processId: number) => void;
  readonly #apps = new Map<string, AppRecord>();

  constructor(runtime: RuntimeDetacher, options: { readonly probeProcess?: (processId: number) => void } = {}) {
    this.#runtime = runtime;
    this.#probeProcess = options.probeProcess ?? ((processId) => { process.kill(processId, 0); });
  }

  async sweepDeadParents(): Promise<void> {
    const retirements: Promise<void>[] = [];
    for (const app of this.#apps.values()) {
      if (app.retiring) { retirements.push(this.#detach(app.appInstanceId)); continue; }
      try { this.#probeProcess(app.processId); }
      catch (error) {
        // Permission denial, unavailable inspection, and PID reuse never prove
        // this registered parent dead. Only the OS's missing-process result does.
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
          retirements.push(this.#detach(app.appInstanceId));
        }
      }
    }
    await Promise.allSettled(retirements);
  }

  activity(): {
    readonly appInstances: number;
    readonly registeredWindows: number;
    readonly bootstrappingWindows: number;
  } {
    return {
      appInstances: this.#apps.size,
      registeredWindows: [...this.#apps.values()].reduce((sum, app) => sum + app.activeWindows, 0),
      bootstrappingWindows: [...this.#apps.values()].reduce((sum, app) => sum + app.bootstrappingWindows, 0),
    };
  }

  async handle(raw: unknown): Promise<NativeAppControlResponse> {
    const message = parseNativeAppControlMessage(raw);
    if (message === undefined) return this.#failure(raw, "invalid");
    if (message.type === "register-app") return this.#register(message);
    const app = this.#apps.get(message.appInstanceId);
    if (app === undefined) return this.#failure(message, "unregistered");
    if (app.retiring) return this.#failure(message, "busy");
    if (message.type === "activity") {
      if (message.activeWindows < app.helpers.size) return this.#failure(message, "invalid");
      app.activeWindows = message.activeWindows;
      app.bootstrappingWindows = message.bootstrappingWindows;
      return this.#ack(message.appInstanceId);
    }
    if (message.type === "detach-helper") {
      await this.#detachHelper(app, message.helperId);
      return this.#ack(message.appInstanceId);
    }
    if (message.type === "prepare-replacement") {
      return app.activeWindows === 0 && app.helpers.size === 0
        ? {
            protocolVersion: 1,
            type: "replacement-ready",
            appInstanceId: app.appInstanceId,
            activeWindows: 0,
          }
        : this.#failure(message, "busy");
    }
    await this.#detach(message.appInstanceId);
    return this.#ack(message.appInstanceId);
  }

  attachHelper(appInstanceId: string, helperId: string): boolean {
    const app = this.#apps.get(appInstanceId);
    if (app === undefined || app.retiring || !/^[A-Za-z0-9_-]{8,128}$/u.test(helperId)
      || app.retiredHelpers.has(helperId)) return false;
    for (const owner of this.#apps.values()) if (owner.helpers.has(helperId)) return false;
    app.helpers.add(helperId);
    return true;
  }

  releaseHelper(appInstanceId: string, helperId: string): Promise<void> {
    const app = this.#apps.get(appInstanceId);
    return app === undefined ? Promise.resolve() : this.#detachHelper(app, helperId);
  }

  ownsHelper(appInstanceId: string, helperId: string): boolean {
    const app = this.#apps.get(appInstanceId);
    return app !== undefined && !app.retiring && !app.retiredHelpers.has(helperId) && app.helpers.has(helperId);
  }

  eof(appInstanceId: string): Promise<void> {
    return this.#detach(appInstanceId);
  }

  parentDied(appInstanceId: string): Promise<void> {
    return this.#detach(appInstanceId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#apps.keys()].map((appInstanceId) => this.#detach(appInstanceId)));
  }

  #register(
    message: Extract<NativeAppControlMessage, { readonly type: "register-app" }>,
  ): NativeAppControlResponse {
    if (this.#apps.has(message.appInstanceId)) return this.#failure(message, "invalid");
    this.#apps.set(message.appInstanceId, {
      appInstanceId: message.appInstanceId,
      processId: message.processId,
      startIdentity: message.startIdentity,
      buildIdentity: message.buildIdentity,
      helpers: new Set(),
      retiredHelpers: new Set(),
      pendingHelpers: new Map(),
      retiring: false,
      activeWindows: 0,
      bootstrappingWindows: 0,
    });
    return this.#ack(message.appInstanceId);
  }

  #detach(appInstanceId: string): Promise<void> {
    const app = this.#apps.get(appInstanceId);
    if (app === undefined) return Promise.resolve();
    if (app.retirement !== undefined) return app.retirement;
    app.retiring = true;
    const retirement = Promise.all([...new Set([...app.helpers, ...app.pendingHelpers.keys()])]
      .map((helperId) => this.#detachHelper(app, helperId)))
      .then(() => {
        if (this.#apps.get(appInstanceId) === app) this.#apps.delete(appInstanceId);
      }).finally(() => { delete app.retirement; });
    app.retirement = retirement;
    return retirement;
  }

  #detachHelper(app: AppRecord, helperId: string): Promise<void> {
    // Retire identity before awaiting cleanup so delayed admissions cannot
    // reacquire it. Keep the app counted until every accepted operation settles.
    app.retiredHelpers.add(helperId);
    const existing = app.pendingHelpers.get(helperId);
    if (existing !== undefined) return existing;
    if (!app.helpers.has(helperId)) return Promise.resolve();
    const retiring = Promise.resolve().then(() => this.#runtime.detach(helperId))
      .then(() => { app.helpers.delete(helperId); })
      .finally(() => { app.pendingHelpers.delete(helperId); });
    app.pendingHelpers.set(helperId, retiring);
    return retiring;
  }

  #ack(appInstanceId: string): NativeAppControlResponse {
    return { protocolVersion: 1, type: "ack", appInstanceId };
  }

  #failure(
    raw: unknown,
    code: Extract<NativeAppControlResponse, { readonly type: "failure" }>["code"],
  ): NativeAppControlResponse {
    const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const appInstanceId = typeof value.appInstanceId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      ? value.appInstanceId : "app_invalid";
    return { protocolVersion: 1, type: "failure", appInstanceId, code };
  }
}
