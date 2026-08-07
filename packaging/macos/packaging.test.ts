import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNotarizationPlan } from "./notarize.js";
import { validateAppBundleManifest, validateBackendRuntimeManifest } from "./validate-manifest.js";
import { finderServiceArgs } from "./launcher.mjs";
import { validateDoctorEvidence } from "./smoke-installed.js";

describe("macOS distribution manifests", () => {
  it("pins one offline runtime and architecture-specific outputs", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as unknown;
    const backend = JSON.parse(await readFile(resolve("packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown;
    expect(validateAppBundleManifest(app).architectures).toEqual(["arm64", "x64"]);
    expect(validateBackendRuntimeManifest(backend).assets.every((asset) => asset.networkFallbackAllowed === false)).toBe(true);
  });

  it("uses current notarytool submission followed by staple and validation", () => {
    expect(createNotarizationPlan("/tmp/PDF-Proofreader-arm64.zip", "/tmp/PDF Proofreader.app", "PDF_PROOFREADER_NOTARY")).toEqual([
      { command: "xcrun", args: ["notarytool", "submit", "/tmp/PDF-Proofreader-arm64.zip", "--keychain-profile", "PDF_PROOFREADER_NOTARY", "--wait", "--output-format", "json"] },
      { command: "xcrun", args: ["stapler", "staple", "/tmp/PDF Proofreader.app"] },
      { command: "xcrun", args: ["stapler", "validate", "/tmp/PDF Proofreader.app"] },
    ]);
  });

  it("translates an installed raw Finder path without putting a capability in process arguments", async () => {
    expect(finderServiceArgs("/tmp/paper.pdf")).toEqual(["open", "--json", "--surface", "finder", "--pdf", "/tmp/paper.pdf"]);
    const launcher = await readFile(resolve("packaging/macos/launcher.mjs"), "utf8");
    expect(launcher).toContain('system attribute "PDF_PROOFREADER_URL"');
    expect(launcher).toContain("PDF_PROOFREADER_PDFIUM_WASM");
    expect(launcher).not.toContain('"/usr/bin/open"');
  });

  it("requires content-free installed writer evidence matching the pinned runtime", () => {
    expect(validateDoctorEvidence({
      ok: true,
      offline: true,
      writer: "embedpdf-node-pdfium",
      nodeVersion: "24.14.0",
      pdfiumSha256: "a".repeat(64),
      pages: 1,
      structurallyValid: true,
    }, "24.14.0", "a".repeat(64))).toMatchObject({ offline: true, pages: 1 });
    expect(() => validateDoctorEvidence({ ok: true, offline: true, writer: "embedpdf-node-pdfium", nodeVersion: "24.14.0", pdfiumSha256: "a".repeat(64), pages: 0, structurallyValid: true }, "24.14.0", "a".repeat(64))).toThrow(/evidence/u);
  });
});
