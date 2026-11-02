import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { parseEditorControlRequest, type EditorControlResponse, type EditorForwardRequest } from "../../../../packages/core/src/editor-navigation-protocol.js";
import { resolveSyncTexSourcePath } from "../files/source-scope.js";
import { EditorProfiles, type EditorRegistration } from "./editor-profiles.js";

export interface NativeEditorIntent {
  readonly request: EditorForwardRequest;
  readonly registration: EditorRegistration;
  readonly association: string;
  readonly sequence: number;
}
interface Destination {
  intent: NativeEditorIntent;
  pending: boolean;
  claimed: boolean;
  helperId?: string;
  appInstanceId?: string;
}
interface Ticket {
  readonly intent: NativeEditorIntent;
  readonly expiresAt: number;
  appInstanceId?: string;
}
const token = (): string => randomBytes(32).toString("base64url");

/** Private daemon authority. Neither tickets nor registrations are public review links. */
export class EditorNavigation {
  readonly #destinations = new Map<string, Destination>();
  readonly #tickets = new Map<string, Ticket>();
  #sequence = 0;
  constructor(
    readonly profiles: EditorProfiles,
    readonly installationIdentity: string,
    readonly now: () => number = Date.now,
    readonly ticketLifetimeMs = 60_000,
  ) {}

  async control(raw: unknown): Promise<EditorControlResponse> {
    const request = parseEditorControlRequest(raw);
    if (request === undefined) return { ok: false, message: "Invalid editor request" };
    try {
      if (request.operation === "profiles") return { ok: true, operation: "profiles",
        profiles: (await this.profiles.list()).map(({ name, kind }) => ({ name, kind })) };
      if (request.operation === "profile-add") {
        await this.profiles.add(request.profile);
        return { ok: true, operation: "profile-add" };
      }
      if (request.operation === "register") {
        const registration = await this.profiles.register(request);
        return { ok: true, operation: "register", session: registration.handle };
      }
      return await this.#accept(request);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Editor request failed" };
    }
  }

  async #accept(request: EditorForwardRequest): Promise<EditorControlResponse> {
    // Allocate before filesystem work: late validation cannot undo newer acceptance.
    const sequence = ++this.#sequence;
    const registration = this.profiles.registration(request.session);
    if (registration === undefined) throw new Error("Editor session expired; register the editor again");
    const pdfPath = await realpath(request.pdfPath);
    if (!(await stat(pdfPath)).isFile() || !pdfPath.toLowerCase().endsWith(".pdf")) throw new Error("PDF must be a local PDF file");
    const source = await resolveSyncTexSourcePath(registration.sourceRoot, request.sourcePath);
    let synctexDirectory: string | undefined;
    if (request.synctexDirectory !== undefined) {
      synctexDirectory = await realpath(request.synctexDirectory);
      if (!(await stat(synctexDirectory)).isDirectory()) throw new Error("SyncTeX directory must be a local directory");
    }
    const previous = this.#destinations.get(pdfPath);
    if (previous !== undefined && previous.intent.sequence > sequence) throw new Error("Navigation was superseded by a newer request");
    if (request.intent === "follow" && (previous === undefined || previous.pending ||
      previous.intent.registration.handle !== registration.handle || previous.intent.association !== request.association)) {
      throw new Error("Follow request is stale or an explicit navigation is still pending");
    }
    const association = request.intent === "follow" ? previous!.intent.association : token();
    const intent: NativeEditorIntent = { request: { ...request, pdfPath, sourcePath: source.path,
      ...(synctexDirectory === undefined ? {} : { synctexDirectory }) }, registration, association, sequence };
    this.#destinations.set(pdfPath, { intent, pending: true, claimed: false,
      ...(previous?.helperId === undefined ? {} : { helperId: previous.helperId }),
      ...(previous?.appInstanceId === undefined ? {} : { appInstanceId: previous.appInstanceId }) });
    this.#expire();
    // Superseded tickets cannot be redeemed, and should not keep the daemon busy.
    for (const [key, value] of this.#tickets) if (value.intent.request.pdfPath === pdfPath) this.#tickets.delete(key);
    const ticket = token();
    this.#tickets.set(ticket, { intent, expiresAt: this.now() + this.ticketLifetimeMs });
    return { ok: true, operation: "forward", ticket, association };
  }

  redeem(ticket: string, appInstanceId: string, installationIdentity: string): { pdfPath: string; navigationHandle: string } | undefined {
    this.#expire();
    const entry = this.#tickets.get(ticket);
    if (entry === undefined || entry.appInstanceId !== undefined || installationIdentity !== this.installationIdentity ||
      !this.isCurrent(entry.intent)) return undefined;
    this.#tickets.delete(ticket);
    const navigationHandle = token();
    this.#tickets.set(navigationHandle, { ...entry, appInstanceId });
    return { pdfPath: entry.intent.request.pdfPath, navigationHandle };
  }

  claim(navigationHandle: string, appInstanceId: string, helperId: string, canonicalPdfPath: string): NativeEditorIntent | undefined {
    this.#expire();
    const entry = this.#tickets.get(navigationHandle);
    if (entry?.appInstanceId !== appInstanceId || entry.intent.request.pdfPath !== canonicalPdfPath || !this.isCurrent(entry.intent)) return undefined;
    this.#tickets.delete(navigationHandle);
    const destination = this.#destinations.get(canonicalPdfPath)!;
    destination.claimed = true;
    destination.appInstanceId = appInstanceId;
    destination.helperId = helperId;
    return entry.intent;
  }

  intentForHelper(helperId: string): NativeEditorIntent | undefined {
    return [...this.#destinations.values()].find(value => value.claimed && value.helperId === helperId)?.intent;
  }
  isCurrent(intent: NativeEditorIntent): boolean {
    return this.#destinations.get(intent.request.pdfPath)?.intent === intent;
  }
  complete(intent: NativeEditorIntent): void {
    const destination = this.#destinations.get(intent.request.pdfPath);
    if (destination?.intent === intent) destination.pending = false;
  }
  detachHelper(helperId: string): void {
    for (const [path, value] of this.#destinations) if (value.helperId === helperId) this.#retire(path);
  }
  detachApp(appInstanceId: string): void {
    for (const [path, value] of this.#destinations) if (value.appInstanceId === appInstanceId) this.#retire(path);
    for (const [key, value] of this.#tickets) if (value.appInstanceId === appInstanceId) {
      this.#tickets.delete(key);
      if (this.isCurrent(value.intent)) this.#destinations.delete(value.intent.request.pdfPath);
    }
  }
  cancelTicket(ticket: string): void {
    const entry = this.#tickets.get(ticket);
    if (entry === undefined) return;
    this.#tickets.delete(ticket);
    if (this.isCurrent(entry.intent)) this.#retire(entry.intent.request.pdfPath);
  }
  activity(): number { this.#expire(); return this.#tickets.size; }
  close(): void { this.#destinations.clear(); this.#tickets.clear(); this.profiles.clear(); }
  #retire(path: string): void {
    this.#destinations.delete(path);
    for (const [key, value] of this.#tickets) if (value.intent.request.pdfPath === path) this.#tickets.delete(key);
  }
  #expire(): void {
    for (const [key, value] of this.#tickets) if (value.expiresAt <= this.now()) {
      this.#tickets.delete(key);
      const destination = this.#destinations.get(value.intent.request.pdfPath);
      if (destination?.intent === value.intent) this.#destinations.delete(value.intent.request.pdfPath);
    }
  }
}
