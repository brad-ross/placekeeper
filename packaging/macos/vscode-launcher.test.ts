import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
  buildVscodeExternalRoute,
  launchVscodeExternalRoute,
  parseVscodeExternalLaunchArguments,
} from "./vscode-launcher.mjs";

const execFileAsync = promisify(execFile);

describe("packaged VS Code compatibility launcher", () => {
  it("routes one exact registered PDF back to the Placekeeper extension", () => {
    const launch = parseVscodeExternalLaunchArguments([
      "--registration", "registration_identifier_1234",
      "--pdf", "/work/paper.pdf",
      "--line", "17",
      "--tex", "/work/paper.tex",
    ]);
    expect(launch).toEqual({
      registrationId: "registration_identifier_1234",
      outputPath: "/work/paper.pdf",
    });
    const route = buildVscodeExternalRoute(launch);
    expect(route).toContain("vscode://placekeeper-local.placekeeper-vscode/placekeeper/external?");
    expect(route).toContain("registration=registration_identifier_1234");
    expect(route).toContain("pdf=%2Fwork%2Fpaper.pdf");
    expect(route).not.toContain("paper.tex");
  });

  it("opens only the VS Code URI handler without a shell or browser URL", async () => {
    const invoke = vi.fn(async () => undefined);
    await launchVscodeExternalRoute({
      registrationId: "registration_identifier_1234",
      outputPath: "/work/paper.pdf",
    }, invoke);
    expect(invoke).toHaveBeenCalledWith("/usr/bin/open", [
      "-g",
      expect.stringMatching(/^vscode:\/\//u),
    ], { shell: false });
    expect(invoke.mock.calls[0]![1].join(" ")).not.toMatch(/https?:\/\//u);
  });

  it("executes its CLI entrypoint through the macOS /tmp symlink and fails closed", async () => {
    const root = await mkdtemp("/tmp/placekeeper-vscode-launcher-");
    const script = resolve(root, "vscode-launcher.mjs");
    try {
      await copyFile(resolve("packaging/macos/vscode-launcher.mjs"), script);
      await expect(execFileAsync(process.execPath, [
        script,
        "--registration", "short",
        "--pdf", "/tmp/paper.pdf",
      ])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [],
    ["--registration", "short", "--pdf", "/work/paper.pdf"],
    ["--registration", "registration_identifier_1234", "--pdf", "https://example.invalid/paper.pdf"],
    ["--registration", "registration_identifier_1234", "--pdf", "/work/paper.tex"],
    ["--registration", "registration_identifier_1234", "--pdf", "/work/paper.pdf", "--unknown", "x"],
  ])("fails closed for invalid launcher arguments %#", (args) => {
    expect(() => parseVscodeExternalLaunchArguments(args)).toThrow();
  });
});
