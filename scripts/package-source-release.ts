import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCE_INSTALL_COMMAND = "curl -fsSL https://brad-ross.github.io/placekeeper/install.sh | sh";

export function releaseIdentity(version: string, commit: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) throw new Error("A stable numeric release version is required");
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("A full source commit is required");
  const tag = `v${version}`;
  const archiveName = `placekeeper-source-${tag}.tar.gz`;
  return { version, commit, tag, archiveName, sourceUrl: `https://github.com/brad-ross/placekeeper/releases/download/${tag}/${archiveName}`, descriptor: `schema=1\nversion=${version}\ncommit=${commit}\n` };
}

export function renderBootstrap(template: string, version: string, commit: string, sha256: string): string {
  const identity = releaseIdentity(version, commit);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid source SHA-256");
  let result = template;
  for (const [key, value] of Object.entries({ VERSION: version, COMMIT: commit, SOURCE_URL: identity.sourceUrl, SHA256: sha256 })) {
    if (!result.includes(`@${key}@`)) throw new Error(`Bootstrap template missing ${key}`);
    result = result.replaceAll(`@${key}@`, value);
  }
  return result;
}

/** Read exclusively from the selected commit, including the bootstrap template. Never include working-tree files. */
export async function packageSourceRelease(repo: string, output: string, version: string, commit: string) {
  const identity = releaseIdentity(version, commit);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 128 * 1024 * 1024 });
  if (git("rev-parse", `${commit}^{commit}`).toString().trim() !== commit) throw new Error("Source commit did not resolve exactly");
  const manifest = JSON.parse(git("show", `${commit}:packaging/macos/app-bundle.json`).toString()) as { bundleVersion: string };
  if (manifest.bundleVersion !== version) throw new Error("Release version differs from canonical app manifest");
  const entries = git("ls-tree", "-r", "--name-only", "-z", commit).toString().split("\0").filter(Boolean);
  if (entries.includes("release-descriptor.txt") || entries.some(path => !/^[A-Za-z0-9_@./-]+$/u.test(path) || path.split("/").some(part => part === ".." || part === "."))) throw new Error("Unsupported source archive path");
  if (/^(120000|160000) /mu.test(git("ls-tree", "-r", commit).toString())) throw new Error("Source releases cannot contain links or submodules");
  const temp = await mkdtemp(join(tmpdir(), "placekeeper-package-"));
  try {
    const descriptor = join(temp, "release-descriptor.txt");
    await writeFile(descriptor, identity.descriptor);
    const tar = git("archive", "--format=tar", "--prefix=placekeeper-source/", `--add-file=${descriptor}`, commit);
    const archive = execFileSync("gzip", ["-n", "-c"], { input: tar, maxBuffer: 128 * 1024 * 1024 });
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const bootstrap = renderBootstrap(git("show", `${commit}:scripts/install-release.sh`).toString(), version, commit, sha256);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, identity.archiveName), archive, { flag: "wx" });
    await writeFile(join(output, "install-placekeeper.sh"), bootstrap, { flag: "wx", mode: 0o755 });
    return { ...identity, sha256 };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, commit, output] = process.argv.slice(2);
  if (!version || !commit || !output || process.argv.length !== 5) throw new Error("Usage: package-source-release.ts VERSION FULL_COMMIT OUTPUT_DIRECTORY");
  console.log(JSON.stringify(await packageSourceRelease(process.cwd(), resolve(output), version, commit), null, 2));
}
