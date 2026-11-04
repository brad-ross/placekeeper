import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(async () => undefined), stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => true })),
  lstat: vi.fn(async () => ({ isSocket: () => true })), realpath: vi.fn(async (path: string) => path),
  readFile: vi.fn(), rm: vi.fn(async () => undefined), writeFile: vi.fn(), rename: vi.fn(), chmod: vi.fn(), mkdir: vi.fn(),
  readPrivateFile: vi.fn(), writePrivateFile: vi.fn(async () => undefined), ensurePrivateDirectory: vi.fn(async () => undefined),
  publishFile: vi.fn(async () => ({ confirmed: true })), syncPublishedFile: vi.fn(async () => undefined),
  resolveSource: vi.fn(), spawn: vi.fn(),
}));
vi.mock("node:fs/promises", () => mocks);
vi.mock("../src/platform/private-storage.js", () => mocks);
vi.mock("../src/platform/file-publication.js", () => mocks);
vi.mock("../src/recovery/source-snapshot.js", () => mocks);
vi.mock("../src/files/source-scope.js", () => ({ resolveSyncTexSourcePath: mocks.resolveSource }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { EditorProfiles } from "../src/synctex/editor-profiles.js";
import { dispatchEditorLocation } from "../src/synctex/editor-dispatch.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.clearAllMocks(); });
const profilesBytes = Buffer.from(JSON.stringify({ version: 1, profiles: [{ name: "nvim", kind: "neovim" }] }));

describe("portable editor destinations", () => {
  it("registers local Windows Neovim pipes without filesystem socket checks", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mocks.readFile.mockResolvedValue(profilesBytes);
    mocks.readPrivateFile.mockResolvedValue(profilesBytes);
    const profiles = new EditorProfiles("C:/private/profiles.json");
    const socket = String.raw`\\.\pipe\nvim-placekeeper`;
    expect(await profiles.register({ profile: "nvim", sourceRoot: "C:/work", socket })).toMatchObject({ socket });
    expect(mocks.lstat).not.toHaveBeenCalled();
  });

  it("rejects filesystem sockets on Windows and named pipes on POSIX", async () => {
    mocks.readFile.mockResolvedValue(profilesBytes);
    mocks.readPrivateFile.mockResolvedValue(profilesBytes);
    const profiles = new EditorProfiles("/private/profiles.json");
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(profiles.register({ profile: "nvim", sourceRoot: "C:/work", socket: "C:/work/nvim.sock" })).rejects.toThrow();
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(profiles.register({ profile: "nvim", sourceRoot: "/work", socket: String.raw`\\.\pipe\nvim` })).rejects.toThrow();
  });

  it("reads and publishes profiles through private platform storage", async () => {
    mocks.readFile.mockResolvedValue(profilesBytes);
    mocks.readPrivateFile.mockResolvedValue(profilesBytes);
    const profiles = new EditorProfiles("/private/profiles.json");
    await profiles.add({ name: "nvim", kind: "neovim" });
    expect(mocks.ensurePrivateDirectory).toHaveBeenCalledWith("/private");
    expect(mocks.readPrivateFile).toHaveBeenCalledWith("/private/profiles.json", 1_048_576);
    expect(mocks.writePrivateFile).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), expect.any(String));
    expect(mocks.publishFile).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), "/private/profiles.json");
    expect(mocks.syncPublishedFile).toHaveBeenCalledWith({ confirmed: true });
  });

  it.each([
    [String.raw`C:\work\paper.tex`, "opened"],
    ["C:/work/paper.tex", "opened"],
    [String.raw`C:\work\part:one.tex`, "failed"],
    ["/work/part:one.tex", "failed"],
    ["C:/work/part\none.tex", "failed"],
  ])("uses direct argv for compound location %s", async (path, status) => {
    mocks.resolveSource.mockResolvedValue({ path });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const result = await dispatchEditorLocation({ handle: "handle", sourceRoot: "C:/work",
      profile: { name: "code", kind: "command", executable: "C:/code.exe", args: ["--goto", "{file}:{line}:{column}"] } },
    { path, line: 7, column: 3 });
    expect(result).toEqual(status === "opened" ? { status: "opened" } : { status: "failed", reason: "unsupported-editor-location-path" });
    if (status === "opened") expect(mocks.spawn).toHaveBeenCalledWith("C:/code.exe", ["--goto", `${path}:7:3`], { shell: false, stdio: "ignore" });
    else expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
