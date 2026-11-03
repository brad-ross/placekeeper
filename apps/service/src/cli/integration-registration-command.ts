import { dirname, extname, isAbsolute, join } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { validateChromeSourceContract } from "../../../../packaging/macos/chrome-integration.js";
import { CHROME_EXTENSION_ID } from "../browser/chrome-handoff.js";
import { registerCandidateIntegration, unregisterCandidateIntegration, renderCandidateChromeManifest, renderCandidateVscodeSettings, candidateCodexPluginFiles, type ChromeRegistryDriver } from "../../../../packaging/desktop/integration-registration.js";
import { requestWindowsNative } from "../platform/windows-native-worker.js";
import { INSTALL_ARTIFACT_IDENTITY_ENV, DAEMON_IDENTITY_ENV } from "../host/service-daemon.js";

const windowsChromeRegistry: ChromeRegistryDriver = {
  async register(path, owner, sha256) {
    const result = await requestWindowsNative({ operation: "registerChromeHost", path, owner, sha256 });
    if (result.status !== "ok") throw new Error("The Chrome native host registry key already exists or could not be registered; existing registration was preserved");
  },
  async unregister(path, owner, sha256) {
    return (await requestWindowsNative({ operation: "unregisterChromeHost", path, owner, sha256 })).status === "ok";
  },
};
const registrationFlags = new Map<string, readonly string[]>([
  ["remove", ["--receipt"]],
  ["vscode", ["--receipt", "--destination", "--launcher"]],
  ["chrome", ["--receipt", "--destination", "--native-host"]],
  ["codex", ["--receipt", "--destination", "--node", "--server", "--launcher"]],
]);

async function executeIntegrationRegistrationCommand(args: readonly string[], write = (text: string) => { process.stdout.write(text); }): Promise<number> {
  const operation = args[1];
  const expected = operation === undefined ? undefined : registrationFlags.get(operation);
  if (!expected || args[0] !== "integration-registration" || args.length !== 2 + expected.length * 2) throw new Error("Choose an explicit integration, destination, and ownership receipt");
  const flags = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index]!; const value = args[index + 1]!;
    if (!expected.includes(flag) || flags.has(flag) || !isAbsolute(value)) throw new Error("Integration paths must be explicit and absolute");
    flags.set(flag, value);
  }
  const installationId = process.env[INSTALL_ARTIFACT_IDENTITY_ENV] ?? "";
  if (!/^[a-f0-9]{64}$/u.test(installationId)) throw new Error("Registration requires an identified installed candidate");
  const receiptPath = flags.get("--receipt")!;
  if (operation === "remove") {
    const result = await unregisterCandidateIntegration(receiptPath, installationId, process.platform === "win32" ? windowsChromeRegistry : undefined);
    write(`${JSON.stringify({ ok: result.retained.length === 0, status: result.retained.length === 0 ? "removed" : "retained", ...result })}\n`);
    return result.retained.length === 0 ? 0 : 2;
  }
  if (operation === "codex") {
    const resources = process.env.PLACEKEEPER_APP_RESOURCES;
    if (!resources || !isAbsolute(resources) || !/^[a-f0-9]{64}$/u.test(process.env[DAEMON_IDENTITY_ENV] ?? "")) throw new Error("Codex setup requires the identified packaged runtime");
    const expectedAssets = new Map([["--node", join(resources, `node/bin/node${process.platform === "win32" ? ".exe" : ""}`)], ["--server", join(resources, "codex-mcp/server.js")], ["--launcher", join(resources, `bin/placekeeper${process.platform === "win32" ? ".exe" : ""}`)]]);
    for (const [flag, expected] of expectedAssets) if (!(await stat(flags.get(flag)!)).isFile() || await realpath(flags.get(flag)!) !== await realpath(expected)) throw new Error("Codex assets must belong to this installation");
    const files = await candidateCodexPluginFiles({ template: join(resources, "integrations/codex-plugin-template"), destination: flags.get("--destination")!, launcher: await realpath(flags.get("--launcher")!), installationId });
    await registerCandidateIntegration({ installationId, receiptPath, files });
    write(`${JSON.stringify({ ok: true, status: "registered", marketplace: flags.get("--destination"), plugin: `codex-plugin@placekeeper-${installationId}`, trust: "pending", recoveryAction: "Add this local marketplace in Codex, install its Placekeeper plugin, review trust and enablement, then fully restart Codex. Trusted launch and display hooks must verify before live context is available." })}\n`); return 0;
  }
  const executable = flags.get(operation === "vscode" ? "--launcher" : "--native-host")!;
  if (!(await stat(executable)).isFile()) throw new Error("The selected native integration executable is missing");
  if (operation === "chrome") {
    if (process.platform === "win32" && extname(executable).toLowerCase() !== ".exe") throw new Error("Windows Chrome requires the packaged native host executable");
    const extension = join(dirname(dirname(executable)), "integrations/chrome-extension");
    validateChromeSourceContract(JSON.parse(await readFile(join(extension, "manifest.json"), "utf8")));
    for (const file of ["handler.html", "popup.html", "background.js", "shared/asset-manifest.json"]) if (!(await stat(join(extension, file))).isFile()) throw new Error("The candidate Chrome extension assets are incomplete");
  }
  const content = operation === "vscode" ? renderCandidateVscodeSettings(executable) : renderCandidateChromeManifest(executable, CHROME_EXTENSION_ID);
  await registerCandidateIntegration({ installationId, receiptPath, files: [{ path: flags.get("--destination")!, content }], ...(operation === "chrome" && process.platform === "win32" ? { chromeRegistry: { path: flags.get("--destination")!, driver: windowsChromeRegistry } } : {}) });
  write(`${JSON.stringify({ ok: true, status: "registered" })}\n`); return 0;
}


export async function runIntegrationRegistrationCommand(args: readonly string[], write = (text: string) => { process.stdout.write(text); }): Promise<number> {
  try { return await executeIntegrationRegistrationCommand(args, write); }
  catch (error) {
    write(`${JSON.stringify({ ok: false, error: { kind: "integration-unavailable", message: error instanceof Error ? error.message : "Integration setup failed", recoveryAction: "Inspect the selected integration and retained ownership receipt; existing registration was preserved" } })}\n`);
    return 2;
  }
}
