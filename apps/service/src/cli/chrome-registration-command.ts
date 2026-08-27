import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  renderChromeNativeHostManifest,
  validateChromeIntegrationBundle,
} from "../../../../packaging/macos/chrome-integration.js";

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || !isAbsolute(value)) throw new Error(`Invalid ${flag}`);
  return value;
}

/** Internal installer operation: validate the candidate pair, then create one
 * no-clobber manifest that names the eventual installed wrapper path. */
export async function runChromeRegistrationCommand(args: readonly string[]): Promise<number> {
  if (
    args.length !== 8 ||
    args[0] !== "chrome-registration" ||
    args[1] !== "render" ||
    !args.includes("--candidate-app") ||
    !args.includes("--installed-app") ||
    !args.includes("--output")
  ) throw new Error("Invalid Chrome registration invocation");
  const candidateApp = valueAfter(args, "--candidate-app");
  const installedApp = valueAfter(args, "--installed-app");
  const output = valueAfter(args, "--output");
  await validateChromeIntegrationBundle(candidateApp);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(
    output,
    `${JSON.stringify(renderChromeNativeHostManifest(installedApp))}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return 0;
}
