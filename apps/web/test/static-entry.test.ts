import { afterEach, describe, expect, it, vi } from "vitest";

const { createRoot } = vi.hoisted(() => ({ createRoot: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot }));

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { desktopAssetNames, parseDesktopRelease, RELEASE_REPOSITORY, type DesktopTarget } from "../../../packages/core/src/desktop-release.js";
import { DownloadButton } from "../src/landing/DownloadButton.js";

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


describe("landing download contract", () => {
  it("renders two independent download disclosures without browser globals or installation instructions", () => {
    vi.stubGlobal("navigator", undefined);
    try {
      const markup = renderToStaticMarkup(createElement(StaticLauncher, { onOpen: async () => {} }));
      expect(markup.match(/aria-label="Other download options"/g)).toHaveLength(2);
      expect(markup.match(/>Download Placekeeper<\/span>/g)).toHaveLength(2);
      const panelIds = [...markup.matchAll(/<nav id="([^"]+)" class="landing-download__panel"/g)].map(match => match[1]);
      expect(new Set(panelIds).size).toBe(2);
      expect(markup).not.toContain("<dialog");
      expect(markup).not.toContain('aria-haspopup="dialog"');
      for (const copy of ["curl -fsSL", "Copy command", "source prerequisites", "unsigned", "Upgrades and recovery", "Install Placekeeper"]) {
        expect(markup).not.toContain(copy);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const releaseVersion = '1.2.3';
const catalog = parseDesktopRelease({
  draft: false,
  prerelease: false,
  tag_name: `v${releaseVersion}`,
  html_url: `${RELEASE_REPOSITORY}/releases/tag/v${releaseVersion}`,
  assets: [...Object.values(desktopAssetNames(releaseVersion)), 'SHA256SUMS'].map(name => ({
    name, state: 'uploaded', size: 123,
    browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${releaseVersion}/${name}`,
  })),
});

describe("split download link semantics", () => {
  it.each<DesktopTarget>(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'])("uses the validated %s artifact as its primary anchor", target => {
    const markup = renderToStaticMarkup(createElement(DownloadButton, { downloads: { status: 'available', catalog }, target }));
    expect(markup).toContain(`<a class="landing-download__main" href="${catalog.downloads[target].url}">`);
    if (target === 'linux-x64') expect(markup).toContain('Download for Linux Debian / Ubuntu x64');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Placekeeper downloads" hidden=""');
    expect(markup).not.toContain('role="menu"');
  });

  it("offers alternatives from the main button for an unidentified device", () => {
    const markup = renderToStaticMarkup(createElement(DownloadButton, { downloads: { status: 'available', catalog }, target: undefined }));
    expect(markup).toContain('<button class="landing-download__main" type="button"');
    expect(markup).toContain('Download Placekeeper');
    for (const artifact of Object.values(catalog.downloads)) expect(markup).toContain(`href="${artifact.url}"`);
    expect(markup).toContain(`href="${RELEASE_REPOSITORY}/blob/main/docs/installation.md">Build from source`);
    expect(markup).toContain(`href="${RELEASE_REPOSITORY}/releases">All releases`);
    expect(markup).not.toContain('/releases/latest');
    expect(markup.match(/<a /g)).toHaveLength(6);
  });

  it.each([
    ['loading', 'Checking downloads…'],
    ['unavailable', null],
  ] as const)("keeps %s platform rows noninteractive", (status, message) => {
    const markup = renderToStaticMarkup(createElement(DownloadButton, { downloads: { status }, target: 'win32-x64' }));
    expect(markup).toContain('<button class="landing-download__main" type="button"');
    expect(markup.match(/<span aria-disabled="true">/g)).toHaveLength(4);
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup).not.toContain('/releases/download/');
    if (message) {
      expect(markup).toContain(message);
    } else {
      expect(markup).not.toContain('role="status"');
    }
    expect(markup).not.toContain('curl');
    expect(markup).not.toContain('unsigned');
    expect(markup).not.toContain('prerequisites');
  });
});
