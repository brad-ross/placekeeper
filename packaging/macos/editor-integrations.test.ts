import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const lua = [process.env.PLACEKEEPER_TEST_LUA, "texlua", "lua", "/Library/TeX/texbin/texlua"]
  .find(candidate => candidate !== undefined && spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
const root = resolve("integrations/editors");
const source = "/projects/Two words/chapters/a'$`;.tex";
const pdf = "/projects/Two words/build/main.pdf";
const substitute = (args: string[], replacements: Record<string, string>) => args.map(arg => replacements[arg] ?? arg);

describe("installed editor recipes", () => {
  it("uses the shared viewer command with a configured profile and explicit intent", async () => {
    const { texlab } = JSON.parse(await readFile(resolve(root, "texlab.json"), "utf8"));
    expect(texlab.build.forwardSearchAfter).toBe(false);
    expect(texlab.build.pdfDirectory).toBe("build");
    expect(texlab.auxDirectory).toBeUndefined();
    expect(substitute(texlab.forwardSearch.args, { "%f": source, "%p": pdf, "%l": "12", "REPLACE_WITH_PROFILE": "my-editor" }))
      .toEqual(["view-source", "--editor", "my-editor", "--source", source, "--line", "12", "--pdf", pdf, "--intent", "explicit"]);
  });
  it("passes Zed paths with spaces and shell syntax literally through its task shell", async () => {
    const [task] = JSON.parse(await readFile(resolve(root, "zed-tasks.json"), "utf8"));
    const directory = await mkdtemp("/tmp/placekeeper-zed-recipe-");
    const capture = resolve(directory, "capture argv");
    try {
      await writeFile(capture, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
      await chmod(capture, 0o700);
      const values: Record<string, string> = {
        "$ZED_FILE": source, "$ZED_ROW": "12",
        "build": "/projects/Two words/output '$`;",
        "/Users/YOU/Applications/Placekeeper.app/Contents/MacOS/placekeeper": capture,
      };
      const env = Object.fromEntries(Object.entries(task.env ?? {}).map(([key, value]) => [key, values[String(value)] ?? String(value)]));
      const command = [values[task.command] ?? task.command, ...substitute(task.args, values)].join(" ");
      const args = JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env } }));
      expect(args).toEqual(["view-source", "--editor", "zed", "--source", source, "--line", "12", "--pdf-directory", values.build]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("passes the Sublime cursor and unusual filename as literal command arguments", () => {
    expect(execFileSync("python3", [resolve("packaging/macos/test-fixtures/sublime-helper.py"), resolve(root, "placekeeper_sublime.py")],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })).toContain("helper checks passed");
  });
  it.skipIf(lua === undefined)("runs the Neovim helper with captured build tokens and literal argv under a Lua fixture", () => {
    expect(execFileSync(lua!, [resolve("packaging/macos/test-fixtures/neovim-helper.lua"), resolve(root, "placekeeper.lua")], { encoding: "utf8" })).toContain("helper checks passed");
  });
});
