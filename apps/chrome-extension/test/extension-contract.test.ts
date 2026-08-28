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
  });

  it("uses native keyboard controls and announced status regions", async () => {
    const [handler, popup] = await Promise.all([
      readFile(resolve(extensionRoot, "handler.html"), "utf8"),
      readFile(resolve(extensionRoot, "popup.html"), "utf8"),
    ]);
    expect(handler).toContain('<button id="bypass" type="button">Use Chrome viewer</button>');
    expect(handler).toContain('role="status"');
    expect(popup).toContain('<button id="automatic-open" class="switch" type="button" role="switch"');
    expect(popup).toContain('aria-checked="false"');
    expect(popup).toContain('role="status"');
  });

  it("uses the compact Placekeeper popup hierarchy without transient loading copy", async () => {
    const popup = await readFile(resolve(extensionRoot, "popup.html"), "utf8");

    expect(popup).toContain("<title>Placekeeper</title>");
    expect(popup).toContain('<h1 id="title">Placekeeper</h1>');
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

  it("navigates the MIME handler's owning tab instead of its child frame", async () => {
    const handlerEntry = await readFile(resolve(extensionRoot, "src/handler-entry.ts"), "utf8");
    expect(handlerEntry).toContain("chrome.tabs.update(tabId, { url: destination })");
    expect(handlerEntry).not.toContain("window.location.replace");
  });
});
