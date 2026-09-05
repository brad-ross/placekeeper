import assert from "node:assert/strict";
import test from "node:test";

import {
  launchPdf,
  openPlacekeeperLink,
  preflightPlacekeeperLink,
} from "../src/launcher-client.mjs";

const LAUNCHER = "/Users/example/Applications/Placekeeper.app/Contents/MacOS/placekeeper";
const PDF = "/private/tmp/paper.pdf";
const LINK = "placekeeper:///private/tmp/paper.pdf#v=1&page=4";
const URL = "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";

test("launches a PDF through the installed service CLI with bounded output and time", async () => {
  const calls = [];
  const exec = async (...input) => {
    calls.push(input);
    return { stdout: JSON.stringify({ ok: true, kind: "opened", url: URL }) };
  };
  assert.equal(await launchPdf({ exec, launcherPath: LAUNCHER, pdfPath: PDF }), URL);
  assert.deepEqual(calls, [[
    LAUNCHER,
    ["open", "--json", "--surface", "finder", "--pdf", PDF],
    { encoding: "utf8", maxBuffer: 65_536, timeout: 15_000, windowsHide: true },
  ]]);
});

test("validates link preflight before presenting its path", async () => {
  const exec = async () => ({
    stdout: JSON.stringify({
      ok: true,
      kind: "link-preflight",
      path: PDF,
      confirmationRequired: true,
    }),
  });
  assert.deepEqual(await preflightPlacekeeperLink({ exec, launcherPath: LAUNCHER, link: LINK }), {
    path: PDF,
    confirmationRequired: true,
  });
});

test("opens a confirmed link without granting the renderer launcher access", async () => {
  const calls = [];
  const exec = async (...input) => {
    calls.push(input);
    return { stdout: JSON.stringify({ ok: true, kind: "focused", url: URL }) };
  };
  assert.equal(await openPlacekeeperLink({
    confirmed: true,
    exec,
    launcherPath: LAUNCHER,
    link: LINK,
  }), URL);
  assert.deepEqual(calls[0][1], [
    "open-link",
    "--json",
    "--surface",
    "finder",
    "--confirmed",
    "--link",
    LINK,
  ]);
});

test("preserves a confirmation recheck and supports one confirmed retry", async () => {
  const calls = [];
  const exec = async (...input) => {
    calls.push(input);
    return calls.length === 1
      ? { stdout: JSON.stringify({ ok: true, kind: "confirmation-required", path: PDF }) }
      : { stdout: JSON.stringify({ ok: true, kind: "opened", url: URL }) };
  };

  assert.deepEqual(await openPlacekeeperLink({
    confirmed: false,
    exec,
    launcherPath: LAUNCHER,
    link: LINK,
  }), {
    kind: "confirmation-required",
    path: PDF,
  });
  assert.equal(await openPlacekeeperLink({
    confirmed: true,
    exec,
    launcherPath: LAUNCHER,
    link: LINK,
  }), URL);
  assert.deepEqual(calls.map((call) => call[1]), [
    ["open-link", "--json", "--surface", "finder", "--link", LINK],
    ["open-link", "--json", "--surface", "finder", "--confirmed", "--link", LINK],
  ]);
});

test("surfaces structured service errors from ordinary nonzero exits", async () => {
  const executionError = Object.assign(new Error("Command failed with exit code 2"), {
    code: 2,
    killed: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      ok: false,
      error: {
        kind: "input-unavailable",
        message: "The linked PDF is no longer readable.",
        recoveryAction: "Open a valid Placekeeper link",
      },
    }),
  });

  await assert.rejects(
    openPlacekeeperLink({
      exec: async () => { throw executionError; },
      launcherPath: LAUNCHER,
      link: LINK,
    }),
    /linked PDF is no longer readable/,
  );
});

test("rethrows non-service execution failures unchanged", async () => {
  const executionError = Object.assign(new Error("Command exited without structured output"), {
    code: 2,
    killed: false,
    signal: null,
    stderr: "failure",
    stdout: "not json",
  });

  await assert.rejects(
    launchPdf({
      exec: async () => { throw executionError; },
      launcherPath: LAUNCHER,
      pdfPath: PDF,
    }),
    (error) => error === executionError,
  );
});

test("fails closed on malformed or recovery responses", async () => {
  await assert.rejects(
    launchPdf({ exec: async () => ({ stdout: "not json" }), launcherPath: LAUNCHER, pdfPath: PDF }),
    /invalid JSON/i,
  );
  await assert.rejects(
    openPlacekeeperLink({
      exec: async () => ({ stdout: JSON.stringify({ ok: true, kind: "recovery-offered" }) }),
      launcherPath: LAUNCHER,
      link: LINK,
    }),
    /recovery is outside/i,
  );
  await assert.rejects(
    openPlacekeeperLink({
      exec: async () => ({
        stdout: JSON.stringify({
          ok: true,
          kind: "confirmation-required",
          path: "/private/tmp/not-a-pdf.txt",
        }),
      }),
      launcherPath: LAUNCHER,
      link: LINK,
    }),
    /invalid Placekeeper link confirmation response/i,
  );
});
