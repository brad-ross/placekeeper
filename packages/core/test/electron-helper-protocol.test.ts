import { expect, it } from "vitest";
import { parseElectronDocumentHelperMessage, validElectronDocumentHelperResponse } from "../src/electron-helper-protocol.js";
import { sanitizeNativeDocumentRuntimeResponse } from "../src/document-runtime-protocol.js";
const base = { protocolVersion: 1, windowId: "window_12345678", attemptId: "attempt_12345678", requestId: "request_12345678" };

it("admits portable absolute Electron paths ", () => {
  for (const sourcePath of ["/tmp/paper.pdf", "C:\\Papers\\paper.pdf", "\\\\server\\share\\paper.pdf"]) {
    expect(parseElectronDocumentHelperMessage({ ...base, type: "admit", sourcePath })).toBeDefined();
  }
  for (const sourcePath of ["paper.pdf", "C:paper.pdf", "\\paper.pdf", "/tmp/bad\0.pdf"]) {
    expect(parseElectronDocumentHelperMessage({ ...base, type: "admit", sourcePath })).toBeUndefined();
  }
});

it("keeps the Electron method and resource request schemas closed", () => {
  const invoke = { ...base, type: "invoke", method: "scope", payload: {}, generation: 1, revision: 0 };
  expect(parseElectronDocumentHelperMessage(invoke)).toBeDefined();
  for (const method of ["bootstrap", "presence", "detach", "exec"]) {
    expect(parseElectronDocumentHelperMessage({ ...invoke, method })).toBeUndefined();
  }
  expect(parseElectronDocumentHelperMessage({ ...invoke, sourcePath: "/tmp/paper.pdf" })).toBeUndefined();
  const read = { ...base, type: "read-resource", resourceId: "resource_12345678", generation: 1, role: "document", offset: 0, length: 65_536 };
  expect(parseElectronDocumentHelperMessage(read)).toBeDefined();
  expect(parseElectronDocumentHelperMessage({ ...read, length: 65_537 })).toBeUndefined();
  expect(parseElectronDocumentHelperMessage({ ...read, role: "worker" })).toBeUndefined();
  expect(parseElectronDocumentHelperMessage({ ...read, sourcePath: "/tmp/paper.pdf" })).toBeUndefined();
});

it("projects an explicit Electron scope with private path and capability fields removed", () => {
  expect(sanitizeNativeDocumentRuntimeResponse("electron", "scope", {
    documentTitle: "Paper.pdf", sourceDisplayName: "Paper.pdf", sourceDisposition: "local", launchSurface: "macos",
    sourceRootPath: "/private/Papers", capability: "private", canonicalLinkBase: "placekeeper:///private/Papers/Paper.pdf",
  })).toEqual({ documentTitle: "Paper.pdf", sourceDisplayName: "Paper.pdf", sourceDisposition: "local", launchSurface: "electron" });
});

it("admits only trusted Electron native destination results while renderer methods remain pathless", () => {
  const selection = { ...base, type: "destination-selection", method: "chooseFolder", generation: 1, revision: 0,
    idempotencyKey: "operation_destination_test", selectedPath: null as string | null };
  for (const selectedPath of [null, "/tmp/Papers", "C:\\Papers", "\\\\server\\share\\Papers"]) {
    expect(parseElectronDocumentHelperMessage({ ...selection, selectedPath })).toBeDefined();
  }
  for (const patch of [
    { selectedPath: "relative" }, { selectedPath: "C:relative" }, { selectedPath: "/tmp/bad\0path" },
    { selectedPath: "/" + "a".repeat(16_384) }, { generation: 0 }, { revision: -1 },
    { idempotencyKey: "short" }, { method: "chooseCopy" }, { payload: {} },
  ]) expect(parseElectronDocumentHelperMessage({ ...selection, ...patch })).toBeUndefined();
  for (const method of ["chooseFolder", "locateSave"]) {
    expect(parseElectronDocumentHelperMessage({ ...base, type: "invoke", generation: 1, revision: 0,
      idempotencyKey: "operation_destination_test", method, payload: {} })).toBeDefined();
    expect(parseElectronDocumentHelperMessage({ ...base, type: "invoke", generation: 1, revision: 0,
      idempotencyKey: "operation_destination_test", method, payload: { selectedPath: "/tmp/private" } })).toBeUndefined();
  }
});

it("keeps task launch admission and visible correlation in the trusted Electron helper schema", () => {
  const launchId = "l".repeat(43);
  const admit = { ...base, type: "admit-launch", launchId };
  expect(parseElectronDocumentHelperMessage(admit)).toBeDefined();
  expect(parseElectronDocumentHelperMessage({ ...admit, launchId: "short" })).toBeUndefined();
  expect(parseElectronDocumentHelperMessage({ ...admit, sourcePath: "/tmp/other.pdf" })).toBeUndefined();
  const activate = { ...base, type: "activate", documentValidated: true, launchId };
  expect(parseElectronDocumentHelperMessage(activate)).toBeDefined();
  expect(parseElectronDocumentHelperMessage({ ...activate, launchId: "invalid" })).toBeUndefined();
});

it("admits pathless Electron SyncTeX requests", () => {
  const invoke = { ...base, type: "invoke", generation: 1, revision: 0 };
  expect(parseElectronDocumentHelperMessage({ ...invoke, method: "forwardSyncTex", payload: { action: "poll" } })).toBeDefined();
  expect(parseElectronDocumentHelperMessage({ ...invoke, method: "reverseSyncTex", payload: { pageIndex: 0, point: { x: 5, y: 6 } } })).toBeDefined();
  expect(parseElectronDocumentHelperMessage({ ...invoke, method: "forwardSyncTex", payload: { action: "poll", sourcePath: "/private/main.tex" } })).toBeUndefined();
});

it("accepts the renamed exportAnnotatedCopy method from a newer peer and keeps the legacy spelling", () => {
  const invoke = { ...base, type: "invoke", generation: 1, revision: 0, payload: {} };
  expect(parseElectronDocumentHelperMessage({ ...invoke, method: "exportReviewedCopy" })).toMatchObject({ method: "exportReviewedCopy" });
  expect(parseElectronDocumentHelperMessage({ ...invoke, method: "exportAnnotatedCopy" })).toMatchObject({ method: "exportReviewedCopy" });
  const exported = { kind: "reviewed-copy", path: "/private/result.pdf", revision: 0, digest: "d".repeat(64) };
  for (const method of ["exportReviewedCopy", "exportAnnotatedCopy"]) {
    expect(validElectronDocumentHelperResponse({ ...base, type: "result", method, payload: exported })).toBe(true);
    expect(validElectronDocumentHelperResponse({ ...base, type: "result", method, payload: { ...exported, kind: "annotated-copy" } })).toBe(true);
  }
});
