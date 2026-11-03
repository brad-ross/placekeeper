import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { candidateCodexPluginFiles, registerCandidateIntegration } from "./integration-registration.js";
import { portableIntegrationSetup } from "./package-assets.js";

it("routes the shared installer through full portable Codex registration", async () => {
  const source = await readFile(join(process.cwd(), "packaging/macos/setup-integrations.mjs"), "utf8");
  expect(portableIntegrationSetup(source)).toContain("if (host === 'codex') return { host, ...await setupPortableCodex(");
  expect(() => portableIntegrationSetup("changed helper")).toThrow("portable adapter");
});

it("stages full plugin setup once, leaves trust pending, and preserves edited registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-codex-setup-"));
  const installer = join(root, "installer");
  await mkdir(installer);
  for (const file of ["setup-integrations.mjs", "setup-zed.mjs", "setup-chrome.mjs", "update-vscode.mjs"]) await cp(join(process.cwd(), "packaging/macos", file), join(installer, file));
  await cp(join(process.cwd(), "packaging/desktop/setup-codex.mjs"), join(installer, "setup-codex.mjs"));
  await cp(join(process.cwd(), "integrations/codex-plugin"), join(root, "integrations/codex-plugin-template"), { recursive: true });
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ installArtifactIdentity: "a".repeat(64) }));
  const { setupPortableCodex } = await import(pathToFileURL(join(installer, "setup-codex.mjs")).href);
  const destination = join(root, "marketplace");
  let registrations = 0;
  const run = async (_command: string, args: string[]) => {
    if (args[0] !== "integration-registration") throw new Error("No supported Codex CLI in this test");
    registrations++;
    const launcher = args[args.indexOf("--launcher") + 1]!;
    const files = await candidateCodexPluginFiles({ template: join(root, "integrations/codex-plugin-template"), destination, launcher, installationId: "a".repeat(64) });
    await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath: `${destination}.receipt.json`, files });
    return { stdout: JSON.stringify({ ok: true, status: "registered" }) };
  };
  expect(await setupPortableCodex({ resources: root, destination, run })).toMatchObject({ status: "pending", path: destination });
  expect(await setupPortableCodex({ resources: root, destination, run })).toMatchObject({ status: "pending" });
  expect(registrations).toBe(1);
  const skill = join(destination, "codex-plugin/skills/placekeeper/SKILL.md");
  await writeFile(skill, "user edit");
  await expect(setupPortableCodex({ resources: root, destination, run })).rejects.toThrow("changed");
  expect(await readFile(skill, "utf8")).toBe("user edit");
});
