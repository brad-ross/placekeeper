import { expect, it } from "vitest";
import { parseElectronReviewHelperMessage } from "../src/electron-helper-protocol.js";
import { parseMacosReviewHelperMessage } from "../src/macos-helper-protocol.js";
import { sanitizeNativeReviewRuntimeResponse } from "../src/review-runtime-protocol.js";
const base = { protocolVersion: 1, windowId: "window_12345678", attemptId: "attempt_12345678", requestId: "request_12345678" };

it("admits portable absolute Electron paths while preserving the Mac schema", () => {
  for (const sourcePath of ["/tmp/paper.pdf", "C:\\Papers\\paper.pdf", "\\\\server\\share\\paper.pdf"]) {
    expect(parseElectronReviewHelperMessage({ ...base, type: "admit", sourcePath })).toBeDefined();
  }
  expect(parseMacosReviewHelperMessage({ ...base, type: "admit", sourcePath: "C:\\Papers\\paper.pdf" })).toBeUndefined();
  for (const sourcePath of ["paper.pdf", "C:paper.pdf", "\\paper.pdf", "/tmp/bad\0.pdf"]) {
    expect(parseElectronReviewHelperMessage({ ...base, type: "admit", sourcePath })).toBeUndefined();
  }
});

it("keeps the Electron method and resource request schemas closed", () => {
  const invoke = { ...base, type: "invoke", method: "scope", payload: {}, generation: 1, revision: 0 };
  expect(parseElectronReviewHelperMessage(invoke)).toBeDefined();
  for (const method of ["bootstrap", "presence", "detach", "reverseSyncTex", "exec"]) {
    expect(parseElectronReviewHelperMessage({ ...invoke, method })).toBeUndefined();
  }
  expect(parseElectronReviewHelperMessage({ ...invoke, sourcePath: "/tmp/paper.pdf" })).toBeUndefined();
  const read = { ...base, type: "read-resource", resourceId: "resource_12345678", generation: 1, role: "document", offset: 0, length: 65_536 };
  expect(parseElectronReviewHelperMessage(read)).toBeDefined();
  expect(parseElectronReviewHelperMessage({ ...read, length: 65_537 })).toBeUndefined();
  expect(parseElectronReviewHelperMessage({ ...read, role: "worker" })).toBeUndefined();
  expect(parseElectronReviewHelperMessage({ ...read, sourcePath: "/tmp/paper.pdf" })).toBeUndefined();
});

it("projects an explicit Electron scope with private path and capability fields removed", () => {
  expect(sanitizeNativeReviewRuntimeResponse("electron", "scope", {
    documentTitle: "Paper.pdf", sourceDisplayName: "Paper.pdf", sourceDisposition: "local", launchSurface: "macos",
    sourceRootPath: "/private/Papers", capability: "private", canonicalLinkBase: "placekeeper:///private/Papers/Paper.pdf",
  })).toEqual({ documentTitle: "Paper.pdf", sourceDisplayName: "Paper.pdf", sourceDisposition: "local", launchSurface: "electron" });
});

it("admits only trusted Electron native destination results while renderer methods remain pathless", () => {
  const selection = { ...base, type: "destination-selection", method: "chooseFolder", generation: 1, revision: 0,
    idempotencyKey: "operation_destination_test", selectedPath: null as string | null };
  for (const selectedPath of [null, "/tmp/Papers", "C:\\Papers", "\\\\server\\share\\Papers"]) {
    expect(parseElectronReviewHelperMessage({ ...selection, selectedPath })).toBeDefined();
    expect(parseMacosReviewHelperMessage({ ...selection, selectedPath })).toBeUndefined();
  }
  for (const patch of [
    { selectedPath: "relative" }, { selectedPath: "C:relative" }, { selectedPath: "/tmp/bad\0path" },
    { selectedPath: "/" + "a".repeat(16_384) }, { generation: 0 }, { revision: -1 },
    { idempotencyKey: "short" }, { method: "chooseCopy" }, { payload: {} },
  ]) expect(parseElectronReviewHelperMessage({ ...selection, ...patch })).toBeUndefined();
  for (const method of ["chooseFolder", "locateSave"]) {
    expect(parseElectronReviewHelperMessage({ ...base, type: "invoke", generation: 1, revision: 0,
      idempotencyKey: "operation_destination_test", method, payload: {} })).toBeDefined();
    expect(parseElectronReviewHelperMessage({ ...base, type: "invoke", generation: 1, revision: 0,
      idempotencyKey: "operation_destination_test", method, payload: { selectedPath: "/tmp/private" } })).toBeUndefined();
  }
});

it("keeps task launch admission and visible correlation in the trusted Electron helper schema", () => {
  const launchId = "l".repeat(43);
  const admit = { ...base, type: "admit-launch", launchId };
  expect(parseElectronReviewHelperMessage(admit)).toBeDefined();
  expect(parseMacosReviewHelperMessage(admit)).toBeUndefined();
  expect(parseElectronReviewHelperMessage({ ...admit, launchId: "short" })).toBeUndefined();
  expect(parseElectronReviewHelperMessage({ ...admit, sourcePath: "/tmp/other.pdf" })).toBeUndefined();
  const activate = { ...base, type: "activate", documentValidated: true, launchId };
  expect(parseElectronReviewHelperMessage(activate)).toBeDefined();
  expect(parseMacosReviewHelperMessage(activate)).toBeUndefined();
  expect(parseElectronReviewHelperMessage({ ...activate, launchId: "invalid" })).toBeUndefined();
});
