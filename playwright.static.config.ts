import { defineConfig } from "@playwright/test";

const SUPPORTED_ENGINES = ["chromium", "firefox", "webkit"] as const;
const SUPPORTED_PROFILES = ["critical", "representative", "exhaustive"] as const;
type BrowserName = typeof SUPPORTED_ENGINES[number];
type StaticCoverageProfile = typeof SUPPORTED_PROFILES[number];

function isSupportedValue<const Values extends readonly string[]>(
  candidate: string,
  values: Values,
): candidate is Values[number] {
  return values.some((value) => value === candidate);
}

function selectedEngine(): BrowserName {
  const candidate = process.env.PLACEKEEPER_STATIC_ENGINE ?? "chromium";
  if (!isSupportedValue(candidate, SUPPORTED_ENGINES)) {
    throw new Error(`PLACEKEEPER_STATIC_ENGINE must be chromium, firefox, or webkit (received ${candidate}).`);
  }
  return candidate;
}

function selectedProfile(): StaticCoverageProfile {
  const candidate = process.env.PLACEKEEPER_STATIC_PROFILE ?? "exhaustive";
  if (!isSupportedValue(candidate, SUPPORTED_PROFILES)) {
    throw new Error(`PLACEKEEPER_STATIC_PROFILE must be critical, representative, or exhaustive (received ${candidate}).`);
  }
  return candidate;
}

const engine = selectedEngine();
const profile = selectedProfile();
const port = Number.parseInt(process.env.PLACEKEEPER_STATIC_PORT ?? "4184", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("PLACEKEEPER_STATIC_PORT must be an unprivileged TCP port.");
}
const origin = `http://127.0.0.1:${port}`;
const baseURL = `${origin}/placekeeper/`;
const grep = profile === "critical"
  ? /@critical/u
  : profile === "representative" ? /@representative/u : undefined;

// Release policy: reduce every Firefox/WebKit-only defect into an
// @representative regression. After browser, Playwright, PDFium, selection,
// worker, object-URL, or download lifecycle upgrades, run
// `pnpm test:static:secondary-full` once before returning to the reduced gate.

export default defineConfig({
  testDir: "./test/acceptance",
  testMatch: ["static-web.spec.ts", "static-web-url.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: `test-results/static-web/${engine}-${profile}`,
  reporter: [
    ["list"],
    ["html", { outputFolder: `playwright-report/static-web/${engine}-${profile}`, open: "never" }],
  ],
  ...(grep === undefined ? {} : { grep }),
  use: {
    baseURL,
    browserName: engine,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    // Serve the existing Pages artifact. The caller owns the single build so
    // every release engine exercises exactly the same bytes.
    command: `PLACEKEEPER_STATIC_BASE=/placekeeper/ pnpm exec vite preview --config apps/web/vite.static.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
