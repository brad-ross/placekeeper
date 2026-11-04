import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { buildNativeLaunchers } from "./native-launcher.js";

it("native entry points preserve arguments, binary streams, stderr and exit status without PATH Node", async () => {
  const root = await mkdtemp(join(tmpdir(), "Placekeeper café native "));
  try {
    await mkdir(join(root, "node/bin"), { recursive: true });
    if (process.platform === "win32") await copyFile(process.execPath, join(root, "node/bin/node.exe"));
    else await symlink(process.execPath, join(root, "node/bin/node"));
    await writeFile(join(root, "launcher.mjs"), `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');
      process.stdout.write(Buffer.concat(chunks));
      process.stderr.write('native stderr');
      process.exitCode = 37;
    `);
    await copyFile(join(root, "launcher.mjs"), join(root, "vscode-launcher.mjs"));
    await buildNativeLaunchers(root, `${process.platform}-${process.arch}`, (command, args) => new Promise((accept, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? accept() : reject(new Error(`${command}: ${output}`)));
    }));
    const args = ["", "spaces and café", 'embedded"quote', "trailing\\", "\\\\\"", "line\nbreak", "$(echo nope) & < >"];
    const bytes = Buffer.from([0, 255, 10, 13, 128, 34]);
    for (const basename of ["placekeeper", "placekeeper-chrome-native-host", "placekeeper-vscode"]) {
      const chrome = basename === "placekeeper-chrome-native-host";
      const executable = join(root, "bin", `${basename}${process.platform === "win32" ? ".exe" : ""}`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      env.PATH = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
      const result = spawnSync(executable, args, { env, input: bytes });
      expect(result.error).toBeUndefined();
      expect({ status: result.status, signal: result.signal, stderr: result.stderr.toString() }).toEqual({ status: 37, signal: null, stderr: "native stderr" });
      const expected = Buffer.concat([Buffer.from(JSON.stringify(chrome ? ["chrome-native-host", ...args] : args) + "\n"), bytes]);
      expect(result.stdout).toEqual(expected);
      expect(result.stderr.toString()).toBe("native stderr");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
