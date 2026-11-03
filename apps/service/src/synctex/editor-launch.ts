import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isEditorToken } from "../../../../packages/core/src/editor-navigation-protocol.js";

const execute = promisify(execFile);
export async function launchEditorNavigation(ticket: string, resources: string): Promise<void> {
  if (!isEditorToken(ticket) || resources === undefined) throw new Error("Run forward-search using the installed Placekeeper.app/Contents/MacOS/placekeeper command");
  const canonical = await realpath(resources);
  const contents = dirname(canonical);
  const app = dirname(contents);
  if (basename(canonical) !== "Resources" || basename(contents) !== "Contents" || !app.endsWith(".app") ||
    !(await stat(join(contents, "MacOS", "PlacekeeperMac"))).isFile()) throw new Error("Placekeeper installation is incomplete");
  await execute("/usr/bin/open", ["-a", app, `placekeeper-navigation://ticket/${ticket}`], { timeout: 10_000, maxBuffer: 16_384 });
}
