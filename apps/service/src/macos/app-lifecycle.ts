import {
  parseMacosAppControlMessage,
  type MacosAppControlMessage,
  type MacosAppControlResponse,
} from "../../../../packages/core/src/macos-app-control-protocol.js";

interface RuntimeDetacher {
  detach(helperId: string): Promise<void>;
}

interface AppRecord {
  readonly appInstanceId: string;
  readonly processId: number;
  readonly startIdentity: string;
  readonly buildIdentity: string;
  readonly helpers: Set<string>;
  activeWindows: number;
  bootstrappingWindows: number;
}

export class MacosAppLifecycleManager {
  readonly #runtime: RuntimeDetacher;
  readonly #apps = new Map<string, AppRecord>();

  constructor(runtime: RuntimeDetacher) {
    this.#runtime = runtime;
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

  async handle(raw: unknown): Promise<MacosAppControlResponse> {
    const message = parseMacosAppControlMessage(raw);
    if (message === undefined) return this.#failure(raw, "invalid");
    if (message.type === "register-app") return this.#register(message);
    const app = this.#apps.get(message.appInstanceId);
    if (app === undefined) return this.#failure(message, "unregistered");
    if (message.type === "activity") {
      if (message.activeWindows < app.helpers.size) return this.#failure(message, "invalid");
      app.activeWindows = message.activeWindows;
      app.bootstrappingWindows = message.bootstrappingWindows;
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
    if (app === undefined || !/^[A-Za-z0-9_-]{8,128}$/u.test(helperId)) return false;
    for (const owner of this.#apps.values()) if (owner.helpers.has(helperId)) return false;
    app.helpers.add(helperId);
    return true;
  }

  releaseHelper(appInstanceId: string, helperId: string): void {
    this.#apps.get(appInstanceId)?.helpers.delete(helperId);
  }

  ownsHelper(appInstanceId: string, helperId: string): boolean {
    return this.#apps.get(appInstanceId)?.helpers.has(helperId) === true;
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
    message: Extract<MacosAppControlMessage, { readonly type: "register-app" }>,
  ): MacosAppControlResponse {
    if (this.#apps.has(message.appInstanceId)) return this.#failure(message, "invalid");
    this.#apps.set(message.appInstanceId, {
      appInstanceId: message.appInstanceId,
      processId: message.processId,
      startIdentity: message.startIdentity,
      buildIdentity: message.buildIdentity,
      helpers: new Set(),
      activeWindows: 0,
      bootstrappingWindows: 0,
    });
    return this.#ack(message.appInstanceId);
  }

  async #detach(appInstanceId: string): Promise<void> {
    const app = this.#apps.get(appInstanceId);
    if (app === undefined) return;
    this.#apps.delete(appInstanceId);
    await Promise.all([...app.helpers].map((helperId) => this.#runtime.detach(helperId)));
  }

  #ack(appInstanceId: string): MacosAppControlResponse {
    return { protocolVersion: 1, type: "ack", appInstanceId };
  }

  #failure(
    raw: unknown,
    code: Extract<MacosAppControlResponse, { readonly type: "failure" }>["code"],
  ): MacosAppControlResponse {
    const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const appInstanceId = typeof value.appInstanceId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      ? value.appInstanceId : "app_invalid";
    return { protocolVersion: 1, type: "failure", appInstanceId, code };
  }
}
