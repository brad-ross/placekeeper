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
