import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface CandidateIntegrationFile {
  readonly path: string;
  readonly content: string;
}
export interface ChromeRegistryDriver {
  register(path: string, owner: string, sha256: string): Promise<void>;
  unregister(path: string, owner: string, sha256: string): Promise<boolean>;
}
interface ChromeRegistryReceipt { readonly path: string; readonly owner: string; readonly sha256: string }
interface RegistrationReceipt {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly registry?: ChromeRegistryReceipt;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly device: number; readonly inode: number }[];
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function validatePaths(receiptPath: string, files: readonly CandidateIntegrationFile[]): void {
  const paths = [receiptPath, ...files.map(file => file.path)];
  if (paths.some(path => !isAbsolute(path) || /[\0\r\n]/u.test(path)) || new Set(paths).size !== paths.length) {
    throw new Error("Integration paths must be distinct absolute paths");
  }
}

/** Opt-in writes to explicit destinations only. Existing host configuration is
 * never overwritten; a different profile or registration must be chosen. */
export async function registerCandidateIntegration(options: {
  readonly installationId: string;
  readonly receiptPath: string;
  readonly files: readonly CandidateIntegrationFile[];
  readonly chromeRegistry?: { readonly path: string; readonly driver: ChromeRegistryDriver };
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(options.installationId) || options.files.length === 0) throw new Error("Invalid candidate registration");
  validatePaths(options.receiptPath, options.files);
  const registryFile = options.chromeRegistry === undefined ? undefined : options.files.find(file => file.path === options.chromeRegistry!.path);
  if (options.chromeRegistry !== undefined && registryFile === undefined) throw new Error("Registry registration requires its owned manifest file");
  const registry = registryFile === undefined ? undefined : { path: registryFile.path, owner: `${options.installationId}:${randomUUID()}`, sha256: digest(registryFile.content) };
  const owned: { path: string; sha256: string; device: number; inode: number }[] = [];
  // Reserve the receipt before any host write; concurrent setup cannot adopt
  // files installed by a competing attempt.
  await mkdir(dirname(options.receiptPath), { recursive: true, mode: 0o700 });
  await writeFile(options.receiptPath, JSON.stringify({ schemaVersion: 1, installationId: options.installationId, files: [] }), { flag: "wx", mode: 0o600 });
  for (const file of options.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { flag: "wx", mode: 0o600 });
    const identity = await lstat(file.path);
    if (!identity.isFile()) throw new Error("Created registration changed before ownership was recorded");
    owned.push({ path: file.path, sha256: digest(file.content), device: identity.dev, inode: identity.ino });
    await writeFile(options.receiptPath, JSON.stringify({ schemaVersion: 1, installationId: options.installationId, files: owned, ...(registry === undefined ? {} : { registry }) }), { mode: 0o600 });
  }
  if (registry !== undefined) await options.chromeRegistry!.driver.register(registry.path, registry.owner, registry.sha256);

}

/** Remove only byte-identical files recorded by this installation. User edits,
 * another installation's files, and all review data remain untouched. */
export async function unregisterCandidateIntegration(receiptPath: string, installationId: string, registryDriver?: ChromeRegistryDriver): Promise<{ removed: string[]; retained: string[] }> {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as RegistrationReceipt;
  if (receipt.schemaVersion !== 1 || receipt.installationId !== installationId || !/^[a-f0-9]{64}$/u.test(installationId) || !Array.isArray(receipt.files)) throw new Error("Registration receipt does not belong to this installation");
  validatePaths(receiptPath, receipt.files.map(file => ({ path: file.path, content: "" })));
  const removed: string[] = []; const retained: string[] = [];
  if (receipt.registry !== undefined) {
    const registry = receipt.registry;
    if (!registryDriver || !receipt.files.some(file => file.path === registry.path && file.sha256 === registry.sha256) ||
        !registry.owner.startsWith(`${installationId}:`) || !/^[a-f0-9]{64}:[a-f0-9-]{36}$/u.test(registry.owner)) throw new Error("Registry receipt cannot be safely reversed on this host");
    const ownedManifest = receipt.files.find(file => file.path === registry.path)!;
    const manifestIdentity = await lstat(registry.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (manifestIdentity !== undefined && (!manifestIdentity.isFile() || manifestIdentity.dev !== ownedManifest.device || manifestIdentity.ino !== ownedManifest.inode || digest(await readFile(registry.path, "utf8")) !== ownedManifest.sha256)) return { removed, retained: [registry.path, "Chrome native host registry"] };
    if (!await registryDriver.unregister(registry.path, registry.owner, registry.sha256)) return { removed, retained: ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.placekeeper.chrome", ...receipt.files.map(file => file.path)] };
  }
  for (const file of receipt.files) {
    const info = await lstat(file.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info === undefined) continue;
    if (!info.isFile() || info.dev !== file.device || info.ino !== file.inode || !/^[a-f0-9]{64}$/u.test(file.sha256) || digest(await readFile(file.path, "utf8")) !== file.sha256) { retained.push(file.path); continue; }
    await unlink(file.path); removed.push(file.path);
  }
  if (retained.length === 0) await unlink(receiptPath);
  return { removed, retained };
}

export function renderCandidateVscodeSettings(launcherPath: string): string {
  if (!isAbsolute(launcherPath)) throw new Error("Select an absolute candidate launcher path");
  return `${JSON.stringify({ "placekeeper.launcherPath": launcherPath }, null, 2)}\n`;
}

export function renderCandidateChromeManifest(nativeHostPath: string, extensionId: string): string {
  if (!isAbsolute(nativeHostPath) || !/^[a-p]{32}$/u.test(extensionId)) throw new Error("Select a native host executable and extension identity");
  return `${JSON.stringify({ name: "com.placekeeper.chrome", description: "Placekeeper candidate native host", path: nativeHostPath, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`;
}

export function renderCandidateCodexMcpConfig(options: {
  readonly node: string;
  readonly server: string;
  readonly launcher: string;
  readonly daemonIdentity: string;
  readonly installationId: string;
}): string {
  if (![options.node, options.server, options.launcher].every(isAbsolute) || !/^[a-f0-9]{64}$/u.test(options.daemonIdentity) || !/^[a-f0-9]{64}$/u.test(options.installationId)) throw new Error("Select identified packaged Codex assets");
  return `${JSON.stringify({ mcpServers: { placekeeper: { command: options.node, args: [options.server], env: {
    PLACEKEEPER_DAEMON_IDENTITY: options.daemonIdentity,
    PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: options.installationId,
    PLACEKEEPER_CANDIDATE_LAUNCHER: options.launcher,
  } } } }, null, 2)}\n`;
}


export function renderCandidateCodexToml(options: Parameters<typeof renderCandidateCodexMcpConfig>[0]): string {
  const config = JSON.parse(renderCandidateCodexMcpConfig(options)) as { mcpServers: { placekeeper: { command: string; args: string[]; env: Record<string, string> } } };
  const server = config.mcpServers.placekeeper;
  return `[mcp_servers.placekeeper]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.placekeeper.env]\n${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`;
}
