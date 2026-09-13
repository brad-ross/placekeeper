import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { releaseIdentity, renderBootstrap, SOURCE_INSTALL_COMMAND } from "./package-source-release.js";

const commit = "a".repeat(40);
const identity = releaseIdentity("1.2.3", commit);
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
type Entry = { name: string; content?: string; type?: string; link?: string };
function archive(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (value: string, offset: number, size: number) => header.write(value, offset, size, "ascii");
    field(entry.name, 0, 100); field("0000755\0", 100, 8); field("0000000\0", 108, 8); field("0000000\0", 116, 8);
    field(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12); field("00000000000\0", 136, 12);
    field("        ", 148, 8); field(entry.type ?? "0", 156, 1); field(entry.link ?? "", 157, 100); field("ustar\0", 257, 6); field("00", 263, 2);
    field(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function fixture(options: { extra?: Entry[]; descriptor?: string; installer?: string; corrupt?: boolean; partial?: boolean; truncated?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "placekeeper-bootstrap-test-")); temps.push(dir);
  const bin = join(dir, "bin"); await mkdir(bin); const temp = join(dir, "tmp"); await mkdir(temp);
  let bytes = archive([
    { name: "placekeeper-source/release-descriptor.txt", content: options.descriptor ?? identity.descriptor },
    { name: "placekeeper-source/install.sh", content: options.installer ?? 'printf "%s\\n" "$@" > "$TEST_MARKER"\nexit 0\n' },
    ...(options.extra ?? []),
  ]);
  if (options.truncated) bytes = bytes.subarray(0, bytes.length - 40);
  await writeFile(join(dir, "archive"), bytes);
  await writeFile(join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_REQUESTS"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; cp "$TEST_ARCHIVE" "$1"; fi; shift; done\nexit ${options.partial ? 18 : 0}\n`, { mode: 0o755 });
  const template = (await readFile(new URL("./install-release.sh", import.meta.url), "utf8")).replace("PATH=/usr/bin:/bin", `PATH=${bin}:/usr/bin:/bin`);
  const bootstrap = renderBootstrap(template, identity.version, commit, options.corrupt ? "b".repeat(64) : createHash("sha256").update(bytes).digest("hex"));
  await writeFile(join(dir, "bootstrap"), bootstrap);
  const env = { ...process.env, TMPDIR: temp, TEST_MARKER: join(dir, "marker"), TEST_REQUESTS: join(dir, "requests"), TEST_ARCHIVE: join(dir, "archive") };
  return { dir, temp, env, run: () => spawnSync("/bin/sh", [join(dir, "bootstrap"), "--integrations=skip"], { env, encoding: "utf8" }) };
}
async function expectRejected(options: Parameters<typeof fixture>[0], message: string) {
  const test = await fixture(options); const result = test.run();
  expect(result.status, result.stderr).not.toBe(0); expect(result.stderr).toContain(message);
  await expect(readFile(test.env.TEST_MARKER)).rejects.toThrow(); expect(await readdir(test.temp)).toEqual([]);
}

describe("release bootstrap", () => {
  it("requests its embedded release only, forwards arguments, and cleans private source", async () => {
    const test = await fixture({ extra: [{ name: "placekeeper-source/patches/@engine@1.0.patch", content: "patch" }] }); const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(test.env.TEST_MARKER, "utf8")).toBe("--integrations=skip\n");
    const requests = await readFile(test.env.TEST_REQUESTS, "utf8");
    expect(requests.trim().split("\n")).toHaveLength(1); expect(requests).toContain(identity.sourceUrl); expect(requests).not.toMatch(/latest|main/);
    expect(result.stdout).toContain(commit); expect(await readdir(test.temp)).toEqual([]);
  });
  it("retains the caller host search path while using system download tools", async () => {
    const test = await fixture({ installer: 'printf "%s" "$PLACEKEEPER_HOST_PATH" > "$TEST_MARKER"\n' });
    Object.assign(test.env, { PATH: "/test/user/bin:/usr/bin:/bin" });
    expect(test.run().status).toBe(0);
    expect(await readFile(test.env.TEST_MARKER, "utf8")).toBe("/test/user/bin:/usr/bin:/bin");
  });
  it("propagates source installer failure", async () => {
    const test = await fixture({ installer: "echo core-output; echo core-error >&2; exit 42\n" }); const result = test.run(); expect(result.status).toBe(42); expect(result.stdout).toContain("core-output"); expect(result.stderr).toContain("core-error"); expect(await readdir(test.temp)).toEqual([]);
  });
  it("cleans source when interrupted", async () => {
    const test = await fixture({ installer: 'kill -TERM "$PPID"\n' }); expect(test.run().status).toBe(143); expect(await readdir(test.temp)).toEqual([]);
  });
  it("rejects partial download before execution", () => expectRejected({ partial: true }, "download failed"));
  it("rejects a truncated archive even with its matching digest", () => expectRejected({ truncated: true }, "Invalid source archive"));
  it("rejects wrong hash", () => expectRejected({ corrupt: true }, "checksum mismatch"));
  it.each([identity.descriptor.replace("1.2.3", "2.0.0"), identity.descriptor.replace(commit, "b".repeat(40)), identity.descriptor.replace("schema=1", "schema=2")])("rejects incompatible descriptor %s", descriptor => expectRejected({ descriptor }, "descriptor"));
  it.each([
    { name: "/tmp/escaped" }, { name: "placekeeper-source/../escaped" }, { name: "other/install.sh" },
    { name: "placekeeper-source/link", type: "2", link: "../../escape" },
    { name: "placekeeper-source/hard", type: "1", link: "/tmp/escape" },
    { name: "placekeeper-source/device", type: "3" },
    { name: "placekeeper-source/release-descriptor.txt", content: identity.descriptor },
  ])("rejects malicious archive $name ($type)", entry => expectRejected({ extra: [entry] }, "Unsafe"));
  it("latest asset absence or a partial executable never executes and has actionable output", async () => {
    const test = await fixture();
    await writeFile(join(test.dir, "bin/curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf \'touch "$TEST_MARKER"\\n\' > "$1"; fi; shift; done\nexit 22\n', { mode: 0o755 });
    const result = spawnSync("/bin/sh", ["-c", SOURCE_INSTALL_COMMAND], { env: { ...test.env, PATH: `${join(test.dir, "bin") }:/usr/bin:/bin` }, encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("stable Placekeeper installer is unavailable");
    await expect(readFile(test.env.TEST_MARKER)).rejects.toThrow(); expect(await readdir(test.temp)).toEqual([]);
  });
});

it("landing command resolves latest once then executes the fully downloaded pinned bootstrap", async () => {
  const test = await fixture();
  await writeFile(join(test.dir, "bin/curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_REQUESTS"
source="$TEST_ARCHIVE"
case "$*" in *releases/latest/download*) source="$TEST_BOOTSTRAP";; esac
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; cp "$source" "$1"; fi; shift; done
`, { mode: 0o755 });
  const result = spawnSync("/bin/sh", ["-c", SOURCE_INSTALL_COMMAND], { env: { ...test.env, PATH: `${join(test.dir, "bin")}:/usr/bin:/bin`, TEST_BOOTSTRAP: join(test.dir, "bootstrap") }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const requests = await readFile(test.env.TEST_REQUESTS, "utf8");
  expect(requests.match(/releases\/latest\/download/g)).toHaveLength(1);
  expect(requests.trim().split("\n")).toHaveLength(2);
  expect(requests).toContain(identity.sourceUrl);
  expect(await readdir(test.temp)).toEqual([]);
});
