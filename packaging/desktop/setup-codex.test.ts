import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { candidateCodexPluginFiles, repairCandidateIntegration } from "./integration-registration.js";


it("stages full plugin setup once, leaves trust pending, and preserves edited registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-codex-setup-"));
  const installer = join(root, "installer");
  await mkdir(installer);
  for (const file of ["setup-integrations.mjs", "launcher.mjs", "install-layout.ts"]) await cp(join(process.cwd(), "packaging/desktop", file), join(installer, file));
  await cp(join(process.cwd(), "packaging/desktop/setup-codex.mjs"), join(installer, "setup-codex.mjs"));
  await cp(join(process.cwd(), "integrations/codex-plugin"), join(root, "integrations/codex-plugin-template"), { recursive: true });
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ installArtifactIdentity: "a".repeat(64) }));
  const { setupPortableCodex } = await import(pathToFileURL(join(installer, "setup-codex.mjs")).href);
  const home = root; const statePath = join(root, "integrations/choices.json"); const destination = join(root, "integrations/codex");
  let registrations = 0;
  const run = async (_command: string, args: string[]) => {
    if (args[0] !== "integration-registration") throw new Error("No supported Codex CLI in this test");
    registrations++;
    const launcher = args[args.indexOf("--launcher") + 1]!;
    const files = await candidateCodexPluginFiles({ template: join(root, "integrations/codex-plugin-template"), destination, launcher, installationId: "a".repeat(64) });
    await repairCandidateIntegration({ installationId: "a".repeat(64), receiptPath: join(root, "integrations/codex.receipt.json"), files });
    return { stdout: JSON.stringify({ ok: true, status: "registered" }) };
  };
  expect(await setupPortableCodex({ resources: root, statePath, home, run })).toMatchObject({ status: "pending", path: destination });
  expect(await setupPortableCodex({ resources: root, statePath, home, run })).toMatchObject({ status: "pending" });
  expect(registrations).toBe(2);
  const skill = join(destination, "codex-plugin/skills/placekeeper/SKILL.md");
  await writeFile(skill, "user edit");
  await expect(setupPortableCodex({ resources: root, statePath, home, run })).rejects.toThrow("changed");
  expect(await readFile(skill, "utf8")).toBe("user edit");
});
