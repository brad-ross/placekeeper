import { afterEach, describe, expect, it, vi } from "vitest";

const { createRoot } = vi.hoisted(() => ({ createRoot: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot }));

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SOURCE_INSTALL_COMMAND as RELEASE_INSTALL_COMMAND } from "../../../scripts/package-source-release.js";
import { SOURCE_INSTALL_COMMAND } from "../src/landing/InstallDialog.js";

import { StaticLauncher, mountStaticBrowserApp } from "../src/static-entry.js";

class FakeHTMLElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeHTMLElement[] = [];
  className = "";
  textContent = "";

  append(...children: FakeHTMLElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeHTMLElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

type ServiceWorkerState = {
  readonly controller: object | null;
  readonly getRegistrations: () => Promise<readonly { readonly scope: string }[]>;
};

function renderedText(element: FakeHTMLElement): string {
  return [element.textContent, ...element.children.map(renderedText)].join(" ");
}

function installEnvironment(options: {
  readonly embedded?: boolean;
  readonly opener?: object | null;
  readonly serviceWorker?: ServiceWorkerState;
}): FakeHTMLElement {
  const root = new FakeHTMLElement();
  const currentWindow: {
    self: object;
    top: object;
    opener: object | null;
    navigator: { serviceWorker?: ServiceWorkerState };
  } = {
    self: {},
    top: {},
    opener: options.opener ?? null,
    navigator: options.serviceWorker === undefined ? {} : { serviceWorker: options.serviceWorker },
  };
  currentWindow.self = currentWindow;
  currentWindow.top = options.embedded ? {} : currentWindow;

  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("window", currentWindow);
  vi.stubGlobal("document", {
    baseURI: "https://example.test/placekeeper/index.html",
    querySelector: (selector: string) => selector === "#root" ? root : null,
    createElement: () => new FakeHTMLElement(),
  });
  return root;
}

describe("static browser startup guards", () => {
  afterEach(() => {
    createRoot.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "an iframe",
      options: { embedded: true },
      message: "cannot run inside another page",
    },
    {
      name: "an opener-controlled tab",
      options: { opener: {} },
      message: "cannot start from a tab that can control this page",
    },
    {
      name: "a controlling service worker",
      options: {
        serviceWorker: {
          controller: {},
          getRegistrations: async () => [],
        },
      },
      message: "cannot run while a service worker controls this page",
    },
    {
      name: "an in-scope service-worker registration",
      options: {
        serviceWorker: {
          controller: null,
          getRegistrations: async () => [{ scope: "https://example.test/placekeeper/" }],
        },
      },
      message: "cannot run under a registered service worker",
    },
    {
      name: "a failed service-worker registration query",
      options: {
        serviceWorker: {
          controller: null,
          getRegistrations: async () => { throw new Error("blocked"); },
        },
      },
      message: "could not confirm that this page is free from service-worker control",
    },
  ])("renders a failure instead of mounting the launcher for $name", async ({ options, message }) => {
    const root = installEnvironment(options);

    await mountStaticBrowserApp();

    expect(renderedText(root)).toContain("Placekeeper did not start");
    expect(renderedText(root)).toContain(message);
    expect(renderedText(root)).not.toContain("Upload PDF");
    expect(createRoot).not.toHaveBeenCalled();
  });
});


describe("landing installation contract", () => {
  it("shows the exact release bootstrap command and qualified prerequisites in one mounted dialog", () => {
    expect(SOURCE_INSTALL_COMMAND).toBe(RELEASE_INSTALL_COMMAND);
    const markup = renderToStaticMarkup(createElement(StaticLauncher, { onOpen: async () => {} }));
    expect(markup.match(/<dialog\b/g)).toHaveLength(1);
    expect(markup.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(markup).not.toContain("archive/refs/heads/main.zip");
    expect(markup).toContain("Apple silicon");
    expect(markup).toContain("macOS 13+");
    expect(markup).toContain("Swift 6+");
    expect(markup).toContain("may require a newer macOS");
    expect(markup).toContain("https://developer.apple.com/documentation/xcode/installing-the-command-line-tools");
  });
});
