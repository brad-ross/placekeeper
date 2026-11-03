import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorNavigation } from "../src/synctex/editor-navigation.js";
import { EditorProfiles } from "../src/synctex/editor-profiles.js";
import { MacosAppLifecycleManager } from "../src/macos/app-lifecycle.js";
import { parseEditorArguments, runEditorCommand } from "../src/cli/editor-command.js";
import type { EditorForwardRequest } from "../../../packages/core/src/editor-navigation-protocol.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "editor-handoff-"))); temporary.push(root);
  await writeFile(join(root, "paper.pdf"), "%PDF-1.7\n");
  await writeFile(join(root, "paper.tex"), "Hello");
  const profiles = new EditorProfiles(join(root, "profiles.json"));
  await profiles.add({ name: "editor", kind: "command", executable: "/usr/bin/true", args: ["{file}"] });
  const registration = await profiles.register({ profile: "editor", sourceRoot: root });
  let now = 100;
  const navigation = new EditorNavigation(profiles, "development", () => now, 1000);
  const request: EditorForwardRequest = { operation: "forward", pdfPath: join(root, "paper.pdf"), sourcePath: join(root, "paper.tex"),
    line: 5, intent: "explicit", session: registration.handle };
  const accept = async (input = request) => {
    const response = await navigation.control(input);
    if (!response.ok || response.operation !== "forward") throw new Error(JSON.stringify(response));
    return response;
  };
  const fence = async () => {
    const response = await navigation.control({ operation: "preview-fence" });
    if (!response.ok || response.operation !== "preview-fence") throw new Error("No preview fence");
    return response.fence;
  };
  const claim = (ticket: string) => {
    const redeemed = navigation.redeem(ticket, "app_one", "development")!;
    return navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", request.pdfPath)!;
  };
  return { root, navigation, request, accept, fence, claim, advance: () => { now += 1001; } };
}

describe("private native navigation handoff", () => {
  it("authorizes admission only for a live redeemed handle, its app-owned helper, and its PDF", async () => {
    const f = await fixture();
    const lifecycle = new MacosAppLifecycleManager({ detach: async () => {} }, f.navigation);
    for (const appInstanceId of ["app_owner_1234", "app_other_1234"]) {
      await lifecycle.handle({ protocolVersion: 1, type: "register-app", appInstanceId, processId: 1,
        startIdentity: "start_1234", buildIdentity: "build_1234", installationIdentity: "development" });
    }
    lifecycle.attachHelper("app_owner_1234", "helper_owner_1234");
    lifecycle.attachHelper("app_other_1234", "helper_other_1234");
    const accepted = await f.accept();
    expect(lifecycle.admitsNavigation("helper_owner_1234", accepted.ticket, f.request.pdfPath)).toBe(false);
    const redeemed = f.navigation.redeem(accepted.ticket, "app_owner_1234", "development")!;
    expect(lifecycle.admitsNavigation("helper_other_1234", redeemed.navigationHandle, f.request.pdfPath)).toBe(false);
    expect(lifecycle.admitsNavigation("helper_owner_1234", redeemed.navigationHandle, "/wrong.pdf")).toBe(false);
    expect(lifecycle.admitsNavigation("helper_owner_1234", redeemed.navigationHandle, f.request.pdfPath)).toBe(true);
    // Admission leaves the handle available for binding after PDF validation.
    expect(lifecycle.admitsNavigation("helper_owner_1234", redeemed.navigationHandle, f.request.pdfPath)).toBe(true);
    f.advance();
    expect(lifecycle.admitsNavigation("helper_owner_1234", redeemed.navigationHandle, f.request.pdfPath)).toBe(false);
  });

  it("configures a direct-open presentation only while its native helper is still owned", async () => {
    const f = await fixture();
    const lifecycle = new MacosAppLifecycleManager({ detach: async () => {} }, f.navigation, () => f.request.pdfPath);
    await lifecycle.handle({ protocolVersion: 1, type: "register-app", appInstanceId: "app_00001", processId: 1,
      startIdentity: "start_001", buildIdentity: "build_001" });
    const setup = { protocolVersion: 1, type: "associate-editor", appInstanceId: "app_00001", helperId: "helper_direct", profile: "editor", sourceRoot: f.root };
    expect((await lifecycle.handle(setup)).type).toBe("navigation-unavailable");
    lifecycle.attachHelper("app_00001", "helper_direct");
    expect((await lifecycle.handle(setup)).type).toBe("ack");
    const intent = f.navigation.intentForHelper("helper_direct")!;
    expect(intent.request.operation).toBe("associate");
    expect((await lifecycle.handle({ ...setup, sourceRoot: "/missing-source-folder" })).type).toBe("navigation-unavailable");
    expect(f.navigation.intentForHelper("helper_direct")).toBe(intent);
    await lifecycle.handle({ protocolVersion: 1, type: "detach-helper", appInstanceId: "app_00001", helperId: "helper_direct" });
    expect((await lifecycle.handle(setup)).type).toBe("navigation-unavailable");
    expect(f.navigation.intentForHelper("helper_direct")).toBeUndefined();
  });

  it("requires the matching installation, redeems once, and binds only the intended PDF and app", async () => {
    const f = await fixture(); const accepted = await f.accept();
    expect(f.navigation.redeem(accepted.ticket, "app_one", "wrong")).toBeUndefined();
    const redeemed = f.navigation.redeem(accepted.ticket, "app_one", "development")!;
    expect(redeemed.pdfPath).toBe(f.request.pdfPath);
    expect(f.navigation.redeem(accepted.ticket, "app_one", "development")).toBeUndefined();
    expect(f.navigation.claim(redeemed.navigationHandle, "app_two", "helper_one", f.request.pdfPath)).toBeUndefined();
    expect(f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", "/another.pdf")).toBeUndefined();
    const intent = f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)!;
    expect(intent.registration.sourceRoot).toBe(f.root);
    expect(f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)).toBeUndefined();
    expect(f.navigation.activity()).toBe(0);
  });
  it("expires tickets and retires redeemed authority when its app detaches", async () => {
    const f = await fixture(); const first = await f.accept(); f.advance();
    expect(f.navigation.activity()).toBe(0);
    expect(f.navigation.redeem(first.ticket, "app_one", "development")).toBeUndefined();
    const second = await f.accept(); const redeemed = f.navigation.redeem(second.ticket, "app_one", "development")!;
    f.navigation.detachApp("app_one");
    expect(f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)).toBeUndefined();
  });
  it("invalidates old tickets and reverse work immediately on explicit acceptance", async () => {
    const f = await fixture(); const first = await f.accept();
    const redeemed = f.navigation.redeem(first.ticket, "app_one", "development")!;
    const old = f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)!;
    f.navigation.complete(old);
    const second = await f.accept({ ...f.request, line: 9 });
    expect(second.association).not.toBe(first.association);
    expect(f.navigation.isCurrent(old)).toBe(false);
    const follow = await f.navigation.control({ ...f.request, intent: "follow", association: first.association });
    expect(follow.ok).toBe(false);
    f.navigation.detachHelper("helper_one");
    expect(f.navigation.redeem(second.ticket, "app_one", "development")).toBeUndefined();
  });
  it("binds only an app-owned helper and keeps the surviving helper when a candidate detaches", async () => {
    const f = await fixture(); const accepted = await f.accept();
    const lifecycle = new MacosAppLifecycleManager({ detach: async () => {} }, f.navigation, () => f.request.pdfPath);
    await lifecycle.handle({ protocolVersion: 1, type: "register-app", appInstanceId: "app_00001", processId: 1,
      startIdentity: "start_001", buildIdentity: "build_001", installationIdentity: "development" });
    const redeemed = await lifecycle.handle({ protocolVersion: 1, type: "redeem-navigation", appInstanceId: "app_00001", ticket: accepted.ticket });
    if (redeemed.type !== "navigation") throw new Error("redemption failed");
    const bind = { protocolVersion: 1, type: "bind-navigation", appInstanceId: "app_00001", helperId: "helper_survivor", navigationHandle: redeemed.navigationHandle };
    expect((await lifecycle.handle(bind)).type).toBe("navigation-unavailable");
    lifecycle.attachHelper("app_00001", "helper_survivor");
    lifecycle.attachHelper("app_00001", "helper_candidate");
    expect((await lifecycle.handle(bind)).type).toBe("ack");
    await lifecycle.handle({ protocolVersion: 1, type: "detach-helper", appInstanceId: "app_00001", helperId: "helper_candidate" });
    expect(f.navigation.intentForHelper("helper_survivor")).toBeDefined();
    await lifecycle.handle({ protocolVersion: 1, type: "detach-helper", appInstanceId: "app_00001", helperId: "helper_survivor" });
    expect(f.navigation.intentForHelper("helper_survivor")).toBeUndefined();
  });
  it("allows follow only after the current explicit request has completed", async () => {
    const f = await fixture(); const first = await f.accept();
    const follow = { ...f.request, intent: "follow" as const, association: first.association };
    expect((await f.navigation.control(follow)).ok).toBe(false);
    const redeemed = f.navigation.redeem(first.ticket, "app_one", "development")!;
    const intent = f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)!;
    f.navigation.complete(intent);
    expect((await f.accept(follow)).association).toBe(first.association);
  });
  it("rejects captured following after inverse search without losing the return editor", async () => {
    const f = await fixture(); const first = await f.accept();
    const redeemed = f.navigation.redeem(first.ticket, "app_one", "development")!;
    const intent = f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)!;
    f.navigation.interruptFollowing(intent);
    expect(f.navigation.intentForHelper("helper_one")).toBe(intent);
    expect((await f.navigation.control({ ...f.request, intent: "follow", association: first.association })).ok).toBe(false);
    const next = await f.accept();
    expect(next.association).not.toBe(first.association);
  });
  it("rejects an old captured follow token after an A-to-B-to-A takeover", async () => {
    const f = await fixture();
    const complete = (ticket: string) => {
      const redeemed = f.navigation.redeem(ticket, "app_one", "development")!;
      const intent = f.navigation.claim(redeemed.navigationHandle, "app_one", "helper_one", f.request.pdfPath)!;
      f.navigation.complete(intent);
    };
    const firstA = await f.accept(); complete(firstA.ticket);
    const editorB = await f.navigation.profiles.register({ profile: "editor", sourceRoot: f.root });
    const b = await f.accept({ ...f.request, session: editorB.handle }); complete(b.ticket);
    const nextA = await f.accept(); complete(nextA.ticket);
    expect((await f.navigation.control({ ...f.request, intent: "follow", association: firstA.association })).ok).toBe(false);
    expect((await f.navigation.control({ ...f.request, intent: "follow", association: nextA.association })).ok).toBe(true);
  });

  it("admits a cold automatic preview and preserves native ticket authority", async () => {
    const f = await fixture();
    const preview = await f.accept({ ...f.request, intent: "preview", association: await f.fence() });
    const intent = f.claim(preview.ticket);
    expect(intent.request).toMatchObject({ intent: "preview", line: 5 });
    expect(f.navigation.intentForHelper("helper_one")).toBe(intent);
  });

  it.each(["explicit", "inverse", "associate", "detach"] as const)("rejects a delayed build after %s and permits future same-owner builds", async action => {
    const f = await fixture();
    const first = await f.accept();
    const intent = f.claim(first.ticket);
    f.navigation.complete(intent);
    const captured = await f.fence();
    if (action === "explicit") f.navigation.complete(f.claim((await f.accept()).ticket));
    if (action === "inverse") f.navigation.interruptFollowing(intent);
    if (action === "associate") await f.navigation.associate("helper_one", "app_one", f.request.pdfPath,
      { profile: "editor", sourceRoot: f.root }, () => true);
    if (action === "detach") f.navigation.detachHelper("helper_one");
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: captured })).ok).toBe(false);
    // Association captures a fresh registration; the former session cannot take it over.
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: await f.fence() })).ok).toBe(action !== "associate");
  });

  it("prevents a fresh preview fence from taking over another editor registration", async () => {
    const f = await fixture();
    const other = await f.navigation.profiles.register({ profile: "editor", sourceRoot: f.root });
    f.navigation.complete(f.claim((await f.accept({ ...f.request, session: other.handle })).ticket));
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: await f.fence() })).ok).toBe(false);
  });

  it("fences builds before and during asynchronous manual validation", async () => {
    const f = await fixture();
    const before = await f.fence();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = f.navigation.profiles.captureRegistration.bind(f.navigation.profiles);
    vi.spyOn(f.navigation.profiles, "captureRegistration").mockImplementation(async input => { await gate; return capture(input); });
    const pending = f.navigation.associate("helper_one", "app_one", f.request.pdfPath,
      { profile: "editor", sourceRoot: f.root }, () => true);
    const during = await f.fence();
    expect(during).not.toBe(before);
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: during })).ok).toBe(false);
    release();
    expect(await pending).toBe(true);
    for (const association of [before, during]) {
      expect((await f.navigation.control({ ...f.request, intent: "preview", association })).ok).toBe(false);
    }
  });

  it("does not let previews overtake an explicit request during filesystem validation", async () => {
    const f = await fixture();
    const before = await f.fence();
    const manual = f.accept({ ...f.request, line: 9 });
    const during = await f.fence();
    const pendingPreview = f.navigation.control({ ...f.request, intent: "preview", association: during });
    const accepted = await manual;
    expect((await pendingPreview).ok).toBe(false);
    for (const association of [before, during]) {
      expect((await f.navigation.control({ ...f.request, intent: "preview", association })).ok).toBe(false);
    }
    const intent = f.claim(accepted.ticket);
    expect(intent.request).toMatchObject({ line: 9, intent: "explicit" });
    f.navigation.complete(intent);
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: await f.fence() })).ok).toBe(true);
  });

  it("rejects a preview invalidated while its asynchronous path validation is in flight", async () => {
    const f = await fixture();
    const current = f.claim((await f.accept()).ticket);
    f.navigation.complete(current);
    // control reaches its first filesystem await before returning this promise.
    const pending = f.navigation.control({ ...f.request, intent: "preview", association: await f.fence() });
    f.navigation.interruptFollowing(current);
    expect((await pending).ok).toBe(false);
    expect(f.navigation.isCurrent(current)).toBe(true);
  });

  it("conservatively fences builds across PDFs while preserving independent manual navigation", async () => {
    const f = await fixture();
    const otherPdf = join(f.root, "other.pdf");
    await writeFile(otherPdf, "%PDF-1.7\n");
    const captured = await f.fence();
    const [first, other] = await Promise.all([f.accept(), f.accept({ ...f.request, pdfPath: otherPdf })]);
    expect(first.ticket).not.toBe(other.ticket);
    expect((await f.navigation.control({ ...f.request, pdfPath: otherPdf, intent: "preview", association: captured })).ok).toBe(false);
    f.navigation.complete(f.claim(first.ticket));
    expect((await f.navigation.control({ ...f.request, intent: "preview", association: await f.fence() })).ok).toBe(true);
  });

  it("does not reuse preview fences across service instances or close", async () => {
    const f = await fixture();
    const captured = await f.fence();
    const restarted = new EditorNavigation(f.navigation.profiles, "development");
    const response = await restarted.control({ operation: "preview-fence" });
    expect(response).toMatchObject({ ok: true, operation: "preview-fence" });
    if (response.ok && response.operation === "preview-fence") expect(response.fence).not.toBe(captured);
    expect((await restarted.control({ ...f.request, intent: "preview", association: captured })).ok).toBe(false);
    f.navigation.close();
    expect(await f.fence()).not.toBe(captured);
  });

  it("requires lifecycle registration and makes failed redemption nonfatal", async () => {
    const f = await fixture(); const accepted = await f.accept();
    const lifecycle = new MacosAppLifecycleManager({ detach: async () => {} }, f.navigation);
    const message = { protocolVersion: 1, type: "redeem-navigation", appInstanceId: "app_00001", ticket: accepted.ticket };
    expect((await lifecycle.handle(message)).type).toBe("failure");
    await lifecycle.handle({ protocolVersion: 1, type: "register-app", appInstanceId: "app_00001", processId: 1,
      startIdentity: "start_001", buildIdentity: "build_001", installationIdentity: "development" });
    expect((await lifecycle.handle(message)).type).toBe("navigation");
    expect((await lifecycle.handle(message)).type).toBe("navigation-unavailable");
    expect((await lifecycle.handle({ protocolVersion: 1, type: "activity", appInstanceId: "app_00001", activeWindows: 0, bootstrappingWindows: 0 })).type).toBe("ack");
  });
});

describe("installed editor CLI", () => {
  it("resolves cwd-relative paths and preserves literal argument templates", () => {
    expect(parseEditorArguments(["editor", "register", "--profile", "editor", "--source-root", "src", "--socket", "nvim.sock"], "/project"))
      .toEqual({ operation: "register", profile: "editor", sourceRoot: "/project/src", socket: "/project/nvim.sock" });
    expect(parseEditorArguments(["editor", "add", "--name", "editor", "--executable", "/usr/bin/true", "--args-json", '["{file}","literal $(touch nope)"]'], "/project"))
      .toMatchObject({ profile: { args: ["{file}", "literal $(touch nope)"] } });
    expect(() => parseEditorArguments(["editor", "list", "--unknown", "x"], "/project")).toThrow("Unknown option");
    expect(() => parseEditorArguments(["editor", "add", "--name", "a", "--name", "b"], "/project")).toThrow("repeated");
  });
  it("requires a captured preview fence and prints it without wrapping", async () => {
    expect(parseEditorArguments(["editor", "preview-fence"], "/project")).toEqual({ operation: "preview-fence" });
    expect(() => parseEditorArguments(["editor", "preview-fence", "--session", "x"], "/project")).toThrow("Unknown option");
    const args = ["forward-search", "--pdf", "paper.pdf", "--source", "paper.tex", "--line", "1", "--session", "s".repeat(43), "--intent", "preview"];
    expect(() => parseEditorArguments(args, "/project")).toThrow("Invalid editor options");
    expect(parseEditorArguments([...args, "--association", "a".repeat(43)], "/project")).toMatchObject({ intent: "preview", association: "a".repeat(43) });
    let output = "";
    expect(await runEditorCommand(["editor", "preview-fence"], {
      exchange: async () => ({ ok: true, operation: "preview-fence", fence: "a".repeat(43) }),
      write: text => { output += text; },
    })).toBe(0);
    expect(output).toBe("a".repeat(43) + "\n");
  });
  it("prints only the session handle on success and sends failures to stderr", async () => {
    let output = "", error = "";
    const options = { write: (text: string) => { output += text; }, diagnostic: (text: string) => { error += text; } };
    expect(await runEditorCommand(["editor", "register", "--profile", "editor", "--source-root", "/project"], {
      ...options, exchange: async () => ({ ok: true, operation: "register", session: "handle" }),
    })).toBe(0);
    expect(output).toBe("handle\n");
    expect(await runEditorCommand(["editor", "list"], { ...options, exchange: async () => ({ ok: false, message: "Restart Placekeeper" }) })).toBe(2);
    expect(error).toContain("Restart Placekeeper");
    expect(output).toBe("handle\n");
  });
});
