import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Preserve published CLI and host paths while every invocation runs Electron's
 * exact bundled service. These aliases are created before bundle signing. */
export async function installMacCompatibility(resources: string): Promise<void> {
  const macos = join(dirname(resources), "MacOS");
  await mkdir(macos, { recursive: true });
  for (const [name, target] of [
    ["placekeeper", "placekeeper"],
    ["placekeeper-vscode", "placekeeper-vscode"],
    ["placekeeper-chrome-host", "placekeeper-chrome-native-host"],
    ["placekeeper-chrome-native-host", "placekeeper-chrome-native-host"],
  ]) {
    const path = join(macos, name!);
    await writeFile(path, `#!/bin/sh\nset -eu\nresources=$(CDPATH= cd -- "$(dirname -- "$0")/../Resources/desktop" && pwd)\nexec "$resources/bin/${target}" "$@"\n`);
    await chmod(path, 0o755);
  }
  for (const name of ["node", "service", "web", "codex-mcp", "integrations", "installer", "runtime-manifest.json"]) {
    await symlink(`desktop/${name}`, join(resources, name));
  }
  await symlink("desktop/runtime-manifest.json", join(resources, "build-identity.json"));
}
