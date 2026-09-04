import type {
  MacosReviewHelperMessage,
} from "../../../../packages/core/src/macos-helper-protocol.js";
import { parseMacosReviewHelperMessage } from "../../../../packages/core/src/macos-helper-protocol.js";
import type { MacosNativeMessage } from "../../../../packages/core/src/macos-shell-protocol.js";

export interface MacosProvisionalAdmission {
  readonly provisionalId: string;
  readonly resourceId: string;
  readonly generation: number;
  readonly byteLength: number;
  readonly digest: string;
}

export interface MacosReviewAuthority {
  admit(sourcePath: string, owner: { readonly windowId: string; readonly attemptId: string }): Promise<MacosProvisionalAdmission>;
  readResource(input: MacosProvisionalAdmission & { readonly offset: number; readonly length: number }): Promise<Uint8Array>;
  release(provisionalId: string): Promise<void>;
}

interface MacosNativeGateEnvelope {
  readonly protocolVersion: 1;
  readonly windowId: string;
  readonly attemptId: string;
  readonly requestId: string;
}

type MacosNativeGateResponse =
  | ({
      readonly type: "admitted";
    } & MacosProvisionalAdmission & MacosNativeGateEnvelope)
  | ({
      readonly type: "resource-bytes";
      readonly sequence: number;
      readonly data: string;
      readonly done: boolean;
    } & MacosNativeGateEnvelope)
  | ({ readonly type: "released" } & MacosNativeGateEnvelope);

export function projectMacosAdmissionToPage(
  admission: MacosProvisionalAdmission,
  displayName: string,
  geometry: { readonly identity: string; readonly trafficLightInset: number; readonly trailingInset: number },
): Extract<MacosNativeMessage, { readonly type: "bootstrap" }> {
  return {
    protocolVersion: 1,
    type: "bootstrap",
    document: {
      displayName,
      resource: {
        url: `placekeeper-resource://document/${admission.resourceId}?generation=${admission.generation}&role=document`,
        generation: admission.generation,
        mime: "application/pdf",
        byteLength: admission.byteLength,
        digest: admission.digest,
      },
    },
    geometry,
  };
}

export class MacosReviewHelperSession {
  #admission: MacosProvisionalAdmission | undefined;
  #closed = false;

  constructor(
    readonly windowId: string,
    readonly attemptId: string,
    private readonly authority: MacosReviewAuthority,
  ) {}

  async handle(raw: unknown): Promise<MacosNativeGateResponse> {
    const message = parseMacosReviewHelperMessage(raw);
    if (message === undefined || message.windowId !== this.windowId || message.attemptId !== this.attemptId) {
      throw new Error("Invalid macOS review helper message");
    }
    if (this.#closed) throw new Error("macOS review helper is closed");
    if (message.type === "admit") return this.#admit(message);
    if (message.type === "read-resource") return this.#read(message);
    await this.close();
    return { ...this.envelope(message.requestId), type: "released" };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const admission = this.#admission;
    this.#admission = undefined;
    if (admission !== undefined) await this.authority.release(admission.provisionalId);
  }

  async #admit(message: Extract<MacosReviewHelperMessage, { readonly type: "admit" }>): Promise<MacosNativeGateResponse> {
    if (this.#admission !== undefined) throw new Error("One provisional admission is allowed per helper attempt");
    const admission = await this.authority.admit(message.sourcePath, {
      windowId: this.windowId,
      attemptId: this.attemptId,
    });
    this.#admission = admission;
    return { ...this.envelope(message.requestId), type: "admitted", ...admission };
  }

  async #read(message: Extract<MacosReviewHelperMessage, { readonly type: "read-resource" }>): Promise<MacosNativeGateResponse> {
    const admission = this.#admission;
    if (admission === undefined || admission.resourceId !== message.resourceId
      || admission.generation !== message.generation || message.role !== "document") {
      throw new Error("Stale or wrong-role macOS resource generation");
    }
    if (message.offset + message.length > admission.byteLength) throw new Error("macOS resource range exceeds admission");
    const bytes = await this.authority.readResource({ ...admission, offset: message.offset, length: message.length });
    return {
      ...this.envelope(message.requestId),
      type: "resource-bytes",
      sequence: Math.floor(message.offset / Math.max(1, message.length)),
      data: Buffer.from(bytes).toString("base64"),
      done: message.offset + bytes.byteLength >= admission.byteLength,
    };
  }

  envelope(requestId: string) {
    return { protocolVersion: 1 as const, windowId: this.windowId, attemptId: this.attemptId, requestId };
  }
}

export class MacosReviewHelperManager {
  readonly #helpers = new Map<string, MacosReviewHelperSession>();

  constructor(private readonly authority: MacosReviewAuthority) {}

  open(windowId: string, attemptId: string): MacosReviewHelperSession {
    if (this.#helpers.has(windowId)) throw new Error("A macOS window already owns a review helper");
    const helper = new MacosReviewHelperSession(windowId, attemptId, this.authority);
    this.#helpers.set(windowId, helper);
    return helper;
  }

  async helperDied(windowId: string): Promise<void> {
    await this.close(windowId);
  }

  async close(windowId: string): Promise<void> {
    const helper = this.#helpers.get(windowId);
    if (helper === undefined) return;
    this.#helpers.delete(windowId);
    await helper.close();
  }

  activeWindowIds(): string[] {
    return [...this.#helpers.keys()].sort();
  }
}

export type MacosAppDetachReason = "eof" | "parent-death" | "controlled-exit";

export class MacosAppLifecycleRegistry {
  #registered = false;
  #activeWindows = new Set<string>();
  #detachReason: MacosAppDetachReason | undefined;

  register(identity: { readonly processId: number; readonly startIdentity: string; readonly buildIdentity: string }): void {
    if (this.#registered || identity.processId <= 0 || identity.startIdentity.length < 8 || identity.buildIdentity.length < 8) {
      throw new Error("Invalid or duplicate macOS app lifecycle registration");
    }
    this.#registered = true;
    this.#detachReason = undefined;
  }

  noteWindow(windowId: string, active: boolean): void {
    if (!this.#registered) throw new Error("macOS app lifecycle lane is not registered");
    if (active) this.#activeWindows.add(windowId);
    else this.#activeWindows.delete(windowId);
  }

  detach(reason: MacosAppDetachReason): void {
    this.#registered = false;
    this.#activeWindows.clear();
    this.#detachReason ??= reason;
  }

  snapshot(): { readonly registered: boolean; readonly activeWindows: number; readonly detachReason?: MacosAppDetachReason } {
    return {
      registered: this.#registered,
      activeWindows: this.#activeWindows.size,
      ...(this.#detachReason === undefined ? {} : { detachReason: this.#detachReason }),
    };
  }
}

export class MacosLifecycleControlSession {
  constructor(
    private readonly registry: MacosAppLifecycleRegistry,
    identity: { readonly processId: number; readonly startIdentity: string; readonly buildIdentity: string },
  ) {
    registry.register(identity);
  }

  eof(): void { this.registry.detach("eof"); }
  parentDied(): void { this.registry.detach("parent-death"); }
  controlledExit(): void { this.registry.detach("controlled-exit"); }
}

const ALLOWED_CHILD_ENVIRONMENT = new Set([
  "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "PLACEKEEPER_RUNTIME_ROOT",
  "PLACEKEEPER_CONTROL_SOCKET", "PLACEKEEPER_BUILD_IDENTITY", "PLACEKEEPER_WINDOW_ID",
  "PLACEKEEPER_ATTEMPT_ID", "PLACEKEEPER_APP_INSTANCE_ID", "PLACEKEEPER_HELPER_ID",
]);

export function minimalMacosChildEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(
    (entry): entry is [string, string] => ALLOWED_CHILD_ENVIRONMENT.has(entry[0]) && entry[1] !== undefined,
  ));
}
