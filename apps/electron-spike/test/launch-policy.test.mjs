import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalPlacekeeperLink,
  createWindowOptions,
  isReviewReadyForProbe,
  linkOpenArguments,
  linkPreflightArguments,
  launchResultUrl,
  launcherArguments,
  requestedPdfPath,
  shouldAllowNavigation,
} from "../src/launch-policy.mjs";

const PDF = "/private/tmp/placekeeper-electron-spike.pdf";
const BOOTSTRAP = "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";

test("extracts one absolute PDF without mistaking Electron switches for documents", () => {
  assert.equal(requestedPdfPath(["Electron", ".", "--inspect=0", PDF]), PDF);
  assert.equal(requestedPdfPath(["Electron", ".", "relative.pdf"]), undefined);
  assert.equal(requestedPdfPath(["Electron", ".", "/private/tmp/not-a-pdf.txt"]), undefined);
  assert.throws(
    () => requestedPdfPath(["Electron", ".", PDF, "/private/tmp/second.pdf"]),
    /one PDF/i,
  );
});

test("delegates document admission to the existing Finder launch surface", () => {
  assert.deepEqual(launcherArguments(PDF), [
    "open",
    "--json",
    "--surface",
    "finder",
    "--pdf",
    PDF,
  ]);
});

test("keeps custom-link preflight and confirmation in the existing service contract", () => {
  const link = "placekeeper:///private/tmp/paper.pdf#v=1&page=4";
  assert.deepEqual(linkPreflightArguments(link), [
    "open-link",
    "--json",
    "--preflight",
    "--link",
    link,
  ]);
  assert.deepEqual(linkOpenArguments(link, true), [
    "open-link",
    "--json",
    "--surface",
    "finder",
    "--confirmed",
    "--link",
    link,
  ]);
});

test("maps the spike-only URL registration back to the canonical Placekeeper link", () => {
  assert.equal(
    canonicalPlacekeeperLink("placekeeper-electron-spike:///private/tmp/paper.pdf#v=1&page=4"),
    "placekeeper:///private/tmp/paper.pdf#v=1&page=4",
  );
  assert.equal(
    canonicalPlacekeeperLink("placekeeper:///private/tmp/paper.pdf#v=1&page=4"),
    "placekeeper:///private/tmp/paper.pdf#v=1&page=4",
  );
  assert.throws(() => canonicalPlacekeeperLink("https://example.com/paper.pdf"), /Placekeeper link/i);
});

test("accepts only an opened or focused bootstrap on the fixed numeric loopback origin", () => {
  assert.equal(launchResultUrl({ ok: true, kind: "opened", url: BOOTSTRAP }), BOOTSTRAP);
  assert.equal(launchResultUrl({ ok: true, kind: "focused", url: BOOTSTRAP }), BOOTSTRAP);

  const sessionId = "779e1d9d-58c1-4b12-8dc2-3449dad132c1";
  const capability = "1234567890123456789012345678901234567890123";
  for (const url of [
    BOOTSTRAP.replace("127.0.0.1", "localhost"),
    BOOTSTRAP.replace(":43179", ":43180"),
    BOOTSTRAP.replace("http://", "http://user@"),
    BOOTSTRAP.replace("/bootstrap", "/bootstrap?query=1"),
    BOOTSTRAP.replace("/bootstrap", "/review"),
    BOOTSTRAP.replace("#cap=", "#token="),
    BOOTSTRAP.replace(sessionId, "779e1d9d5-8c1-4b12-8dc2-3449dad132c1"),
    BOOTSTRAP.replace(sessionId, "-".repeat(36)),
    BOOTSTRAP.replace(sessionId, "779e1d9d-58c1-0b12-8dc2-3449dad132c1"),
    BOOTSTRAP.replace(sessionId, "779e1d9d-58c1-4b12-7dc2-3449dad132c1"),
    ...[32, 42, 44].map((length) => BOOTSTRAP.replace(capability, "a".repeat(length))),
  ]) {
    assert.throws(() => launchResultUrl({ ok: true, kind: "opened", url }), /launch response/i);
  }
  assert.throws(() => launchResultUrl({ ok: false, kind: "opened", url: BOOTSTRAP }), /launch response/i);
});

test("keeps the renderer sandboxed and free of Node or preload authority", () => {
  const options = createWindowOptions();
  assert.deepEqual(options.webPreferences, {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  assert.equal("preload" in options.webPreferences, false);
});

test("allows only the Placekeeper loopback origin to remain inside the window", () => {
  assert.equal(shouldAllowNavigation(BOOTSTRAP), true);
  assert.equal(shouldAllowNavigation("http://127.0.0.1:43179/r/review-id"), true);
  assert.equal(shouldAllowNavigation("https://example.com/paper.pdf"), false);
  assert.equal(shouldAllowNavigation("http://localhost:43179/r/review-id"), false);
  assert.equal(shouldAllowNavigation("not a url"), false);
});

test("does not call the live probe ready until bootstrap authority is gone and the viewer settled", () => {
  const ready = {
    hasPdfWorkspaceLoading: false,
    hasProductionReview: true,
    hasViewerFramingViewport: true,
    hasViewerStatus: false,
    url: "http://127.0.0.1:43179/r/779e1d9d-58c1-4b12-8dc2-3449dad132c1/private/tmp/paper.pdf#v=1&page=1",
  };
  assert.equal(isReviewReadyForProbe(ready), true);
  assert.equal(isReviewReadyForProbe({ ...ready, url: BOOTSTRAP }), false);
  assert.equal(isReviewReadyForProbe({ ...ready, hasProductionReview: false }), false);
  assert.equal(isReviewReadyForProbe({
    ...ready,
    hasPdfWorkspaceLoading: true,
    hasViewerFramingViewport: false,
  }), false);
  assert.equal(isReviewReadyForProbe({ ...ready, hasPdfWorkspaceLoading: true }), false);
  assert.equal(isReviewReadyForProbe({ ...ready, hasViewerFramingViewport: false }), false);
  assert.equal(isReviewReadyForProbe({ ...ready, hasViewerStatus: true }), false);
});
