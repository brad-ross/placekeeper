import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve(import.meta.dirname, "..");

describe("Chrome extension static contract", () => {
  it("registers only top-level PDFs on Chrome 151+ with a stable identity", async () => {
    const manifest = JSON.parse(await readFile(resolve(extensionRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("151");
    expect(manifest.permissions).toEqual(["nativeMessaging", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.key).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(manifest.mime_types_handler).toEqual({
      "application/pdf": {
        handler_url: "handler.html",
      },
    });
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self'",
    });
  });

  it("ships only the production embedded handler after the installed platform proof passes", async () => {
    const handlerEntry = await readFile(resolve(extensionRoot, "src/handler-entry.ts"), "utf8");
    expect(handlerEntry).not.toContain("PlatformProof");
    expect(handlerEntry).not.toContain("platformProof");
    expect(handlerEntry).not.toContain("placekeeperPlatformProofEnabled");
    expect(handlerEntry).toContain("void controller.run()");
  });

  it("uses native keyboard controls and announced status regions", async () => {
    const [handler, popup] = await Promise.all([
      readFile(resolve(extensionRoot, "handler.html"), "utf8"),
      readFile(resolve(extensionRoot, "popup.html"), "utf8"),
    ]);
    expect(handler).toContain('class="handler-dialog"');
    expect(handler).toContain('role="dialog"');
    expect(handler).toContain('class="handler-dialog__header"');
    expect(handler).toContain('class="handler-dialog__body"');
    expect(handler).toContain('class="handler-dialog__footer"');
    expect(handler).toContain('<button id="bypass" type="button">Default</button>');
    expect(handler).toContain('role="status"');
    expect(popup).toContain('<button id="automatic-open" class="switch" type="button" role="switch"');
    expect(popup).toContain('aria-checked="false"');
    expect(popup).toContain('role="status"');
  });

  it("uses the compact Placekeeper popup hierarchy without transient loading copy", async () => {
    const popup = await readFile(resolve(extensionRoot, "popup.html"), "utf8");

    expect(popup).toContain("<title>Placekeeper</title>");
    expect(popup).toContain('<h1 id="title" tabindex="-1">Placekeeper</h1>');
    expect(popup).toContain('class="switch"');
    expect(popup).toContain('<span class="switch__label">Open PDFs automatically</span>');
    expect(popup).toContain('<span class="switch__control" aria-hidden="true">');
    expect(popup).not.toContain("Choose whether");
    expect(popup).not.toContain("Reading Chrome");
  });

  it("keeps the popup toggle inert until its saved state is known", async () => {
    const popupEntry = await readFile(resolve(extensionRoot, "src/popup-entry.ts"), "utf8");
    expect(popupEntry.indexOf("control.disabled = true;")).toBeLessThan(
      popupEntry.indexOf("void refresh()"),
    );
    expect(popupEntry).toContain("const nextEnabled = !enabled;");
  });

  it("never replaces the MIME handler's owning tab on the production path", async () => {
    const handlerEntry = await readFile(resolve(extensionRoot, "src/handler-entry.ts"), "utf8");
    expect(handlerEntry).not.toContain("chrome.tabs.update");
    expect(handlerEntry).not.toContain("window.location.replace");
  });

  it("mounts the packaged shared client directly in the PDF handler", async () => {
    const [handlerEntry, handler] = await Promise.all([
      readFile(resolve(extensionRoot, "src/handler-entry.ts"), "utf8"),
      readFile(resolve(extensionRoot, "handler.html"), "utf8"),
    ]);
    expect(handlerEntry).toContain('chrome.runtime.getURL("shared/app.js")');
    expect(handlerEntry).toContain('chrome.runtime.getURL("shared/app.css")');
    expect(handlerEntry).toContain("createNativeEmbeddedReview");
    expect(handler).toContain('<div id="root"');
  });

  it("presents protected recovery as a labeled, keyboard-focusable choice", async () => {
    const [handlerEntry, handlerUi, styles] = await Promise.all([
      readFile(resolve(extensionRoot, "src/handler-entry.ts"), "utf8"),
      readFile(resolve(extensionRoot, "src/handler-ui.ts"), "utf8"),
      readFile(resolve(extensionRoot, "src/extension.css"), "utf8"),
    ]);

    expect(handlerEntry).toContain('handlerActions!.setAttribute("aria-label", "Protected recovery choices")');
    expect(handlerEntry).toContain('title!.textContent = "Existing review recovered"');
    expect(handlerEntry).toContain('setHandlerButtonContent(bypass, "chrome", "Default")');
    expect(handlerUi).toContain('["discard", "Discard", "delete", "destructive"]');
    expect(handlerUi).toContain('["fork", "Fork", "git-fork", "secondary"]');
    expect(handlerUi).toContain('["resume", "Resume", "redo", "primary"]');
    expect(handlerEntry).toContain('recoveryActions.className = "handler-recovery-actions"');
    expect(handlerEntry).toContain('resume.focus({ preventScroll: true })');
    expect(handlerUi).toContain('button.className = `handler-button');
    expect(handlerUi).toContain('icon.classList.add("handler-icon")');
    expect(handlerUi).toContain('"git-fork"');
    expect(handlerUi).toContain('["circle", { cx: "12", cy: "18", r: "3" }]');
    expect(handlerUi).toContain('fill: "currentColor"');
    expect(handlerUi).toContain('stroke: "none"');
    expect(styles).toContain("min-height: var(--review-control-default)");
    expect(styles).toContain("justify-content: flex-end");
    expect(styles).toContain(".handler-button--primary");
    expect(styles).toContain(".handler-button--destructive");
    expect(styles).toContain("width: 14px");
    expect(styles).toContain('.handler-button[data-icon="chrome"] .handler-icon');
    expect(styles).toContain('.handler-button[data-icon="git-fork"] .handler-icon');
  });
});
