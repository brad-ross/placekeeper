import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isEditorToken } from "../../../../packages/core/src/editor-navigation-protocol.js";
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from "../platform/runtime-layout.js";

/** Resolve only the executable belonging to the verified desktop installation. */
export async function resolveNavigationExecutable(resources: string, identity: string): Promise<string> {
  const root = await realpath(resources);
  const resourceDirectory = dirname(root);
  if (basename(root) !== "desktop" || basename(resourceDirectory) !== (process.platform === "darwin" ? "Resources" : "resources")) {
    throw new Error("Placekeeper installation is incomplete");
  }
  const manifest = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8")) as PackagedRuntimeManifest;
  await resolvePackagedRuntime(root, manifest, { daemonIdentity: manifest.daemonIdentity, installArtifactIdentity: identity });
  const executable = process.platform === "darwin"
    ? join(dirname(resourceDirectory), "MacOS", "PlacekeeperDesktop")
    : join(dirname(resourceDirectory), process.platform === "win32" ? "PlacekeeperDesktop.exe" : "PlacekeeperDesktop");
  if (!(await lstat(executable)).isFile() || await realpath(executable) !== executable) throw new Error("Placekeeper desktop executable is unavailable");
  return executable;
}

export async function launchEditorNavigation(ticket: string, resources: string, identity: string, daemonArgs: readonly string[] = []): Promise<void> {
  if (!isEditorToken(ticket) || typeof resources !== "string" || typeof identity !== "string") {
    throw new Error("Run forward-search using the installed Placekeeper command");
  }
  const executable = await resolveNavigationExecutable(resources, identity);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--placekeeper-navigation", ticket, ...daemonArgs], { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
