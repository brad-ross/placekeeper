import { describe, expect, it } from "vitest";
import { releaseIdentity, SOURCE_INSTALL_COMMAND } from "./package-source-release.js";

describe("source release identity", () => {
  it("pins a stable version and full revision", () => {
    expect(releaseIdentity("1.2.3", "a".repeat(40))).toMatchObject({ tag: "v1.2.3", archiveName: "placekeeper-source-v1.2.3.tar.gz" });
  });
  it.each(["latest", "1.2.3-beta", "../1.2.3", "1.2", "01.2.3"])("rejects unsafe or unstable version %s", version => {
    expect(() => releaseIdentity(version, "a".repeat(40))).toThrow();
  });
  it("rejects abbreviated revisions and downloads completely before execution", () => {
    expect(() => releaseIdentity("1.2.3", "abc")).toThrow();
    expect(SOURCE_INSTALL_COMMAND).toContain("releases/latest/download/install-placekeeper.sh");
    expect(SOURCE_INSTALL_COMMAND).not.toContain("| sh");
    expect(SOURCE_INSTALL_COMMAND.indexOf(' -o "$d/install.sh"')).toBeLessThan(SOURCE_INSTALL_COMMAND.indexOf('/bin/sh "$d/install.sh"'));
  });
});

// Isolated repositories model tested revisions; no checkout/index writes occur in this repository.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { packageSourceRelease } from "./package-source-release.js";

it("packages only the tested commit and produces mutually consistent immutable assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placekeeper-release-fixture-"));
  try {
    const repo = join(dir, "repo"); const output = join(dir, "assets");
    await mkdir(join(repo, "packaging/macos"), { recursive: true }); await mkdir(join(repo, "scripts"));
    await writeFile(join(repo, "packaging/macos/app-bundle.json"), JSON.stringify({ bundleVersion: "1.2.3" }));
    await writeFile(join(repo, "patch@1.0.patch"), "tracked dependency patch");
    await writeFile(join(repo, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(repo, "scripts/install-release.sh"), await readFile(new URL("./install-release.sh", import.meta.url)));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const commit = git("rev-parse", "HEAD").trim();
    await writeFile(join(repo, "install.sh"), "uncommitted executable must never ship"); await writeFile(join(repo, "untracked"), "must never ship");
    const identity = await packageSourceRelease(repo, output, "1.2.3", commit);
    const bytes = await readFile(join(output, identity.archiveName));
    const repeated = join(dir, "repeated-assets");
    await packageSourceRelease(repo, repeated, "1.2.3", commit);
    expect(await readFile(join(repeated, identity.archiveName))).toEqual(bytes);
    expect(identity.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const bootstrap = await readFile(join(output, "install-placekeeper.sh"), "utf8");
    expect(bootstrap).toContain(identity.sourceUrl); expect(bootstrap).toContain(identity.sha256); expect(bootstrap).not.toContain("@VERSION@");
    const sourceInstaller = execFileSync("tar", ["-xOzf", join(output, identity.archiveName), "placekeeper-source/install.sh"], { encoding: "utf8" });
    expect(sourceInstaller).toBe("#!/bin/sh\nexit 0\n");
    expect(execFileSync("tar", ["-xOzf", join(output, identity.archiveName), "placekeeper-source/release-descriptor.txt"], { encoding: "utf8" })).toBe(identity.descriptor);
    expect(execFileSync("tar", ["-tzf", join(output, identity.archiveName)], { encoding: "utf8" })).not.toContain("untracked");
    await expect(packageSourceRelease(repo, output, "1.2.3", commit)).rejects.toThrow(/EEXIST/);
    await expect(packageSourceRelease(repo, join(dir, "wrong-version"), "1.2.4", commit)).rejects.toThrow("canonical app manifest");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("accepts the actual tracked source pathname alphabet", () => {
  const names = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean);
  expect(names.filter(name => !/^[A-Za-z0-9_@./-]+$/u.test(name))).toEqual([]);
});

describe("source publication workflow", () => {
  const workflow = () => readFile(new URL("../.github/workflows/release-source.yml", import.meta.url), "utf8");
  it("restricts dispatch to trusted main and isolates release write permission", async () => {
    const source = await workflow();
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain("ref: ${{ github.sha }}");
    expect(source.match(/contents: write/g)).toHaveLength(1);
    expect(source).toContain("needs: validate");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).not.toMatch(/secrets\.MACOS|sign-identity|notarize/);
    for (const action of source.matchAll(/uses: ([^\s]+)/g)) expect(action[1]).toMatch(/@[a-f0-9]{40}$/);
  });
  it("requires every concrete gate and build-bound Chrome evidence before publication", async () => {
    const source = await workflow();
    for (const gate of ["pnpm typecheck", "pnpm test:source-release", "packaging/macos/packaging.test.ts", "pnpm test:upgrade-lifecycle", "pnpm package:macos", "pnpm smoke:installed", "pnpm test:chrome-handoff", "validate-installed-chrome-evidence.ts"]) expect(source).toContain(gate);
    expect(source).toContain("PLACEKEEPER_INSTALLED_CHROME_EVIDENCE: ${{ inputs.installed_chrome_evidence }}");
    expect(source).not.toContain("release:validate");
  });
  it("rejects duplicates before gates and publication and completes a draft before stable promotion", async () => {
    const source = await workflow();
    expect(source.match(/getRef\(/g)).toHaveLength(2);
    expect(source.match(/repos.listReleases/g)).toHaveLength(2);
    expect(source).toContain("canonical app manifest");
    expect(source).toContain("draft: true");
    expect(source.indexOf("uploadReleaseAsset(")).toBeLessThan(source.indexOf("updateRelease("));
    expect(source).toContain("make_latest: 'true'");
    expect(source).not.toMatch(/deleteRelease|deleteReleaseAsset|--clobber/);
    expect(source).toContain("SOURCE_VERSION: ${{ inputs.version }}");
    expect(source).toContain("SOURCE_NOTES: ${{ inputs.notes }}");
  });
});

it("keeps publication private on duplicates, missing assets, or upload failure", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-source.yml", import.meta.url), "utf8");
  const script = workflow.split("      - name: Publish complete source release\n")[1]!.split("          script: |\n")[1]!.split("\n").map(line => line.replace(/^            /, "")).join("\n");
  const run = new Function("github", "context", "require", "process", `return (async () => {${script}\n})();`) as (...args: unknown[]) => Promise<void>;
  for (const failure of ["branch", "tag", "draft", "missing", "upload", "incomplete", "digest", "none"]) {
    const calls: string[] = [];
    const assets: { name: string; size: number }[] = [];
    const github = { rest: { git: { getRef: async () => { if (failure === "tag") return {}; throw Object.assign(new Error("Not found"), { status: 404 }); } }, repos: {
      listReleases: "releases", listReleaseAssets: "assets",
      createRelease: async (request: { draft: boolean }) => { expect(request.draft).toBe(true); calls.push("draft"); return { data: { id: 1 } }; },
      uploadReleaseAsset: async (asset: { name: string; data: Buffer }) => { if (failure === "upload") throw new Error("Upload failed"); assets.push({ name: asset.name, size: asset.data.length }); },
      updateRelease: async (request: { draft: boolean; make_latest: string }) => { expect(request).toMatchObject({ draft: false, make_latest: "true" }); calls.push("public"); },
    } }, paginate: async (method: string) => method === "releases" ? failure === "draft" ? [{ tag_name: "v0.1.0" }] : [] : failure === "incomplete" ? [] : assets };
    const fs = { readFileSync: () => { if (failure === "missing") throw new Error("Missing asset"); return Buffer.from("asset"); } };
    const promise = run(github, { ref: failure === "branch" ? "refs/heads/untrusted" : "refs/heads/main", repo: {}, sha: "a".repeat(40) }, (name: string) => name === "node:crypto" ? { createHash } : fs, { env: { SOURCE_VERSION: "0.1.0", SOURCE_NOTES: "Release notes", EXPECTED_ARCHIVE_SHA256: failure === "digest" ? "wrong" : createHash("sha256").update("asset").digest("hex"), EXPECTED_BOOTSTRAP_SHA256: createHash("sha256").update("asset").digest("hex") } });
    if (failure === "none") { await promise; expect(calls).toEqual(["draft", "public"]); }
    else { await expect(promise).rejects.toThrow(); expect(calls).not.toContain("public"); if (["branch", "tag", "draft", "missing"].includes(failure)) expect(calls).toEqual([]); }
  }
});
