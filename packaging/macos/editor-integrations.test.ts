import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseEditorArguments } from "../../apps/service/src/cli/editor-command.js";

const lua = [process.env.PLACEKEEPER_TEST_LUA, "texlua", "lua", "/Library/TeX/texbin/texlua"]
  .find(candidate => candidate !== undefined && spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
const root = resolve("integrations/editors");
const session = "s".repeat(43);
const source = "/projects/Two words/chapters/a'$`;.tex";
const pdf = "/projects/Two words/build/main.pdf";
const substitute = (args: string[], replacements: Record<string, string>) => args.map(arg => replacements[arg] ?? arg);

describe("installed editor recipes", () => {
  it("uses current Texlab argv placeholders with following off and an explicit registration", async () => {
    const { texlab } = JSON.parse(await readFile(resolve(root, "texlab.json"), "utf8"));
    expect(texlab.build.forwardSearchAfter).toBe(false);
    expect(texlab.build.pdfDirectory).toBe("build");
    expect(texlab.auxDirectory).toBeUndefined();
    expect(parseEditorArguments(substitute(texlab.forwardSearch.args, { "%f": source, "%p": pdf, "%l": "12", "REPLACE_WITH_SESSION": session }), "/unrelated"))
      .toMatchObject({ operation: "forward", intent: "explicit", sourcePath: source, pdfPath: pdf, line: 12, session });
  });
  it("keeps Zed cursor variables as separate arguments and uses the root PDF for included files", async () => {
    const [task] = JSON.parse(await readFile(resolve(root, "zed-tasks.json"), "utf8"));
    expect(parseEditorArguments(substitute(task.args, { "$ZED_FILE": source, "$ZED_ROW": "12", "REPLACE_WITH_SESSION": session,
      "/ABSOLUTE/PROJECT/build/main.pdf": pdf }), "/unrelated"))
      .toMatchObject({ sourcePath: source, pdfPath: pdf, line: 12, intent: "explicit" });
  });
  it("passes the Sublime cursor and unusual filename as literal command arguments", () => {
    expect(execFileSync("python3", [resolve("packaging/macos/test-fixtures/sublime-helper.py"), resolve(root, "placekeeper_sublime.py")],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })).toContain("helper checks passed");
  });
  it.skipIf(lua === undefined)("runs the Neovim helper with captured build tokens and literal argv under a Lua fixture", () => {
    expect(execFileSync(lua!, [resolve("packaging/macos/test-fixtures/neovim-helper.lua"), resolve(root, "placekeeper.lua")], { encoding: "utf8" })).toContain("helper checks passed");
  });
});
