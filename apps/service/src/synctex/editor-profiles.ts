import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEditorControlRequest, parseEditorProfile, type EditorProfile, type EditorRegistrationRequest } from "../../../../packages/core/src/editor-navigation-protocol.js";

export interface EditorRegistration {
  readonly handle: string;
  readonly profile: EditorProfile;
  readonly sourceRoot: string;
  readonly socket?: string;
}

export async function validateEditorExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
  if (!(await stat(path)).isFile()) throw new Error("Editor executable must be a file");
}

export class EditorProfiles {
  readonly #registrations = new Map<string, EditorRegistration>();
  #writeTail: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  async list(): Promise<EditorProfile[]> {
    let bytes: Buffer;
    try { bytes = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (bytes.byteLength > 1_048_576) throw new Error("Editor profile file is too large");
    const data = JSON.parse(bytes.toString("utf8")) as { version?: unknown; profiles?: unknown };
    if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error("Editor profile file is invalid");
    const result = data.profiles.map(parseEditorProfile);
    if (result.some(profile => profile === undefined)) throw new Error("Editor profile file is invalid");
    return result as EditorProfile[];
  }

  async add(input: EditorProfile): Promise<void> {
    const profile = parseEditorProfile(input);
    if (profile === undefined) throw new Error("Invalid editor profile or argument template");
    if (profile.kind === "command") await validateEditorExecutable(profile.executable);
    const write = this.#writeTail.then(async () => {
      const profiles = (await this.list()).filter(candidate => candidate.name !== profile.name);
      profiles.push(profile);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, profiles }) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      } finally { await rm(temporary, { force: true }); }
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  async register(input: EditorRegistrationRequest): Promise<EditorRegistration> {
    const registration = await this.captureRegistration(input);
    this.#registrations.set(registration.handle, registration);
    return registration;
  }

  async captureRegistration(input: EditorRegistrationRequest): Promise<EditorRegistration> {
    if (parseEditorControlRequest({ ...input, operation: "register" }) === undefined) throw new Error("Invalid editor registration");
    const profile = (await this.list()).find(candidate => candidate.name === input.profile);
    if (profile === undefined) throw new Error(`Editor profile '${input.profile}' is not configured`);
    const sourceRoot = await realpath(input.sourceRoot);
    if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Source root must be a directory");
    if (profile.kind === "command") {
      if (input.socket !== undefined) throw new Error("A command profile cannot use a Neovim socket");
      await validateEditorExecutable(profile.executable);
    } else if (input.socket === undefined || !(await lstat(input.socket)).isSocket()) {
      throw new Error("Start Neovim with a local listen socket and register that socket");
    }
    const handle = randomBytes(32).toString("base64url");
    const registration = Object.freeze({ handle, profile: Object.freeze(profile.kind === "command"
      ? { ...profile, args: Object.freeze([...profile.args]) } : profile), sourceRoot,
      ...(input.socket === undefined ? {} : { socket: input.socket }) });
    return registration;
  }

  registration(handle: string): EditorRegistration | undefined { return this.#registrations.get(handle); }
  clear(): void { this.#registrations.clear(); }
}
