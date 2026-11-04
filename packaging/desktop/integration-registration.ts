import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export interface CandidateIntegrationFile {
  readonly path: string;
  readonly content: string;
}
export interface ChromeRegistryDriver {
  register(path: string, owner: string, sha256: string): Promise<void>;
  unregister(path: string, owner: string, sha256: string): Promise<boolean>;
  matches?(path: string, owner: string, sha256: string): Promise<boolean>;
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

/** Refresh only registrations whose complete ownership receipt still matches.
 * Validate the whole set before any writes so a user edit preserves every file. */
export async function repairCandidateIntegration(options: Parameters<typeof registerCandidateIntegration>[0]): Promise<"registered" | "current" | "repaired"> {
  const previous = await readFile(options.receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (previous === undefined) { await registerCandidateIntegration(options); return "registered"; }
  const receipt = JSON.parse(previous) as RegistrationReceipt;
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(receipt.installationId) || !Array.isArray(receipt.files) || receipt.files.length === 0) throw new Error("Invalid retained registration receipt");
  validatePaths(options.receiptPath, options.files);
  if (!/^[a-f0-9]{64}$/u.test(options.installationId) || options.files.length === 0) throw new Error("Invalid candidate registration");
  validatePaths(options.receiptPath, receipt.files.map(file => ({path:file.path,content:""})));
  for (const file of options.files.filter(candidate => !receipt.files.some(old => old.path === candidate.path))) {
    const exists = await lstat(file.path).then(() => true, (error:NodeJS.ErrnoException) => {if(error.code === "ENOENT") return false; throw error;});
    if(exists) throw new Error("New registration path already belongs to another file; existing files were preserved");
  }
  for (const file of receipt.files) {
    const info = await lstat(file.path);
    if (!info.isFile() || info.dev !== file.device || info.ino !== file.inode || digest(await readFile(file.path, "utf8")) !== file.sha256) throw new Error("Registration changed; existing files were preserved");
  }
  if (receipt.installationId === options.installationId && receipt.files.length === options.files.length && options.files.every(file => receipt.files.some(old => old.path === file.path && old.sha256 === digest(file.content)))) {
    if (receipt.registry) {
      if (!options.chromeRegistry?.driver.matches) throw new Error("Chrome registry ownership could not be verified; inspect the retained receipt");
      if (!await options.chromeRegistry.driver.matches(receipt.registry.path, receipt.registry.owner, receipt.registry.sha256)) {
        await options.chromeRegistry.driver.register(receipt.registry.path, receipt.registry.owner, receipt.registry.sha256);
      }
    }
    return "current";
  }
  if (receipt.registry && (!options.chromeRegistry || !await options.chromeRegistry.driver.unregister(receipt.registry.path, receipt.registry.owner, receipt.registry.sha256))) throw new Error("Chrome registry changed; registration preserved");
  const files: RegistrationReceipt["files"][number][] = [];
  for (const file of options.files) {
    await mkdir(dirname(file.path), {recursive:true,mode:0o700});
    await writeFile(file.path, file.content, { mode: 0o600, ...(receipt.files.some(old => old.path === file.path) ? {} : {flag:"wx"}) });
    const info = await lstat(file.path);
    files.push({ path: file.path, sha256: digest(file.content), device: info.dev, inode: info.ino });
    const remaining = receipt.files.filter(old => !files.some(updated => updated.path === old.path));
    await writeFile(options.receiptPath, JSON.stringify({ ...receipt, files: [...files, ...remaining] }), { mode: 0o600 });
  }
  for(const old of receipt.files.filter(file => !options.files.some(candidate => candidate.path === file.path))) {
    await unlink(old.path);
  }
  const registry = options.chromeRegistry ? { path: options.chromeRegistry.path, owner: `${options.installationId}:${randomUUID()}`, sha256: digest(options.files.find(file => file.path === options.chromeRegistry!.path)!.content) } : undefined;
  await writeFile(options.receiptPath, JSON.stringify({ schemaVersion: 1, installationId: options.installationId, files, ...(registry ? {registry} : {}) }), { mode: 0o600 });
  if (registry) await options.chromeRegistry!.driver.register(registry.path, registry.owner, registry.sha256);
  return "repaired";
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
  return `${JSON.stringify({ name: "com.placekeeper.chrome", description: "Placekeeper native host", path: nativeHostPath, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`;
}

/** Materialize the complete plugin at setup time, after the installation has
 * reached its final location. Codex copies plugins into a cache, so runtime
 * paths must refer to the selected installation, never the plugin cache. */
export async function candidateCodexPluginFiles(options: {
  readonly template: string;
  readonly destination: string;
  readonly launcher: string;
  readonly installationId: string;
  readonly platform?: NodeJS.Platform;
}): Promise<CandidateIntegrationFile[]> {
  const { template, destination, launcher, installationId } = options;
  if (![template, destination, launcher].every(isAbsolute) || /[\0\r\n]/u.test(launcher) || !/^[a-f0-9]{64}$/u.test(installationId)) throw new Error("Select identified packaged Codex assets");
  const windows = (options.platform ?? process.platform) === "win32";
  const portableLauncher = windows ? launcher.replaceAll("\\", "/") : launcher;
  // Hooks run through the host shell. For Windows reject expansion characters
  // rather than risk binding the hook to a different executable.
  if (windows && /[%!"\r\n]/u.test(portableLauncher)) throw new Error("The installation path cannot be safely used by Codex hooks");
  const literal = `'${portableLauncher.replaceAll("'", "'\\''")}'`;
  const skillLauncher = windows ? `& '${portableLauncher.replaceAll("'", "''")}'` : literal;
  const hookCommand = `${literal} hook --event`;
  const files: CandidateIntegrationFile[] = [];
  async function visit(relative = ""): Promise<void> {
    for (const entry of await readdir(join(template, relative), { withFileTypes: true })) {
      const suffix = join(relative, entry.name);
      if (entry.isDirectory()) { await visit(suffix); continue; }
      if (!entry.isFile()) throw new Error("Unexpected Codex plugin template asset");
      if (suffix.replaceAll("\\", "/") === "scripts/mcp.sh") continue;
      let content = await readFile(join(template, suffix), "utf8");
      const name = suffix.replaceAll("\\", "/");
      if (name === ".mcp.json") content = JSON.stringify({ mcpServers: { placekeeper: { command: launcher, args: ["codex-mcp"] } } }, null, 2) + "\n";
      if (name === "hooks/hooks.json") {
        const hooks = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>> };
        for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
          hook.command = hookCommand;
          if (windows) hook.commandWindows = `"${portableLauncher}" hook --event`;
        }
        content = JSON.stringify(hooks, null, 2) + "\n";
      }
      if (name.endsWith(".md")) {
        content = content.replaceAll('"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper"', skillLauncher).replace("installed app-bundle launch client", "installed native launch client");
        if (windows) content = content.replaceAll("single quotes, escaping any embedded single quote", "PowerShell single quotes, doubling any embedded single quote").replaceAll("Single-quote the path and escape embedded single quotes", "Use PowerShell single quotes and double embedded single quotes").replaceAll("through the shell execution tool:", "through the PowerShell execution tool (the leading & is PowerShell's call operator):");
      }
      files.push({ path: join(destination, "codex-plugin", suffix), content });
    }
  }
  await visit();
  files.push({ path: join(destination, ".agents/plugins/marketplace.json"), content: JSON.stringify({ name: `placekeeper-${installationId}`, interface: { displayName: "Placekeeper Installed" }, plugins: [{ name: "codex-plugin", source: { source: "local", path: "./codex-plugin" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2) + "\n" });
  return files;
}
