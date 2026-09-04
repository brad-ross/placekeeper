import { afterEach, describe, expect, it, vi } from "vitest";

const { createRoot } = vi.hoisted(() => ({ createRoot: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot }));

import { mountStaticBrowserApp } from "../src/static-entry.js";

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
    expect(renderedText(root)).not.toContain("Choose a PDF");
    expect(createRoot).not.toHaveBeenCalled();
  });
});
