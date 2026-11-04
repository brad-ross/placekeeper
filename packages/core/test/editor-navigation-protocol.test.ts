import { describe, expect, it } from "vitest";
import { isEditorPath, parseEditorControlRequest, parseEditorProfile } from "../src/editor-navigation-protocol.js";

describe("local editor command protocol", () => {
  it("accepts closed profiles and preserves literal arguments", () => {
    const profile = { name: "zed", kind: "command", executable: "/usr/local/bin/zed", args: ["{file}:{line}:{column}"] };
    expect(parseEditorProfile(profile)).toEqual(profile);
    expect(parseEditorProfile({ ...profile, command: "sh -c anything" })).toBeUndefined();
    expect(parseEditorProfile({ ...profile, args: ["{unknown}"] })).toBeUndefined();
    for (const args of [["{file"], ["file}"], ["{file}", "{oops}"], ["--help"]]) {
      expect(parseEditorProfile({ ...profile, args })).toBeUndefined();
    }
    expect(parseEditorProfile({ name: "nvim", kind: "neovim" })).toEqual({ name: "nvim", kind: "neovim" });
  });

  it("accepts absolute Windows drive and UNC paths without accepting relative or device paths", () => {
    for (const path of [String.raw`C:\Users\Brad\paper.tex`, "C:/Users/Brad/paper.tex", String.raw`\\server\share\paper.tex`]) {
      expect(isEditorPath(path)).toBe(true);
      expect(parseEditorProfile({ name: "code", kind: "command", executable: path, args: ["{file}"] })).toBeDefined();
      expect(parseEditorControlRequest({ operation: "forward", pdfPath: path, sourcePath: path,
        line: 1, session: "s".repeat(43), intent: "explicit" })).toBeDefined();
    }
    for (const path of ["C:paper.tex", String.raw`\paper.tex`, String.raw`\\server`, String.raw`\\.\pipe\nvim`, String.raw`\\?\C:\paper.tex`, "relative.tex"]) {
      expect(isEditorPath(path)).toBe(false);
    }
  });

  it("allows local named pipes only for the Neovim endpoint", () => {
    const socket = String.raw`\\.\pipe\nvim-placekeeper`;
    expect(parseEditorControlRequest({ operation: "register", profile: "nvim", sourceRoot: "C:/work", socket }))
      .toEqual({ operation: "register", profile: "nvim", sourceRoot: "C:/work", socket });
    for (const socket of [String.raw`\\remote\pipe\nvim`, String.raw`\\.\pipe` + "\\", String.raw`\\.\pipe\..\nvim`]) {
      expect(parseEditorControlRequest({ operation: "register", profile: "nvim", sourceRoot: "C:/work", socket })).toBeUndefined();
    }
  });

  it("requires a captured association for follow, not just a reusable session", () => {
    const request = { operation: "forward", pdfPath: "/work/build/paper.pdf", sourcePath: "/work/chapter.tex", line: 12,
      session: "s".repeat(43), intent: "follow" };
    expect(parseEditorControlRequest(request)).toBeUndefined();
    expect(parseEditorControlRequest({ ...request, association: "a".repeat(43) })).toMatchObject(request);
    expect(parseEditorControlRequest({ ...request, intent: "explicit" })).toMatchObject({ intent: "explicit" });
    expect(parseEditorControlRequest({ ...request, intent: "explicit", executable: "/bin/sh" })).toBeUndefined();
    expect(parseEditorControlRequest({ ...request, intent: "explicit", line: 0 })).toBeUndefined();
  });
  it("requires bounded preview fence tokens and closed fence requests", () => {
    expect(parseEditorControlRequest({ operation: "preview-fence" })).toEqual({ operation: "preview-fence" });
    expect(parseEditorControlRequest({ operation: "preview-fence", session: "s".repeat(43) })).toBeUndefined();
    const request = { operation: "forward", pdfPath: "/work/paper.pdf", sourcePath: "/work/paper.tex", line: 1,
      session: "s".repeat(43), intent: "preview" };
    for (const association of [undefined, "", "short", "a".repeat(200), "a".repeat(42) + "/"]) {
      expect(parseEditorControlRequest({ ...request, association })).toBeUndefined();
    }
    expect(parseEditorControlRequest({ ...request, association: "a".repeat(43) })).toMatchObject(request);
  });

});
