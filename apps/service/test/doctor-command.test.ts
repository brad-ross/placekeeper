import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDoctorCommand } from "../src/cli/doctor-command.js";

const PDFIUM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8";

afterEach(() => vi.unstubAllEnvs());

describe("installed writer doctor", () => {
  it("emits only exact offline structural evidence for the pinned writer", async () => {
    vi.stubEnv("PLACEKEEPER_PDFIUM_WASM", resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm"));
    const output: string[] = [];
    const code = await runDoctorCommand([
      "doctor", "--json", "--offline", "--writer", "--pdf",
      resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"),
    ], (text) => output.push(text));

    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({
      ok: true,
      offline: true,
      writer: "embedpdf-node-pdfium",
      nodeVersion: process.versions.node,
      pdfiumSha256: PDFIUM_SHA256,
      pages: 1,
      structurallyValid: true,
    });
  });

  it("fails closed without the absolute pinned PDFium runtime", async () => {
    vi.stubEnv("PLACEKEEPER_PDFIUM_WASM", "relative/pdfium.wasm");
    const output: string[] = [];
    expect(await runDoctorCommand([
      "doctor", "--json", "--offline", "--writer", "--pdf", "/missing.pdf",
    ], (text) => output.push(text))).toBe(2);
    expect(JSON.parse(output.join(""))).toEqual({ ok: false, error: "writer-unavailable" });
  });

  it("reports path-free actionable Chrome integration health", async () => {
    const healthy: Parameters<typeof runDoctorCommand>[2] = {
      inspectChrome: async () => ({
        ok: true,
        status: "healthy",
        action: "none",
        extensionId: "cgegjjjhbhnfgcoipeffhogoojfoekgg",
        protocol: 1,
      }),
    };
    const output: string[] = [];
    expect(await runDoctorCommand(
      ["doctor", "--json", "--chrome"],
      (text) => output.push(text),
      healthy,
    )).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({
      ok: true,
      status: "healthy",
      action: "none",
      extensionId: "cgegjjjhbhnfgcoipeffhogoojfoekgg",
      protocol: 1,
    });

    const mismatchOutput: string[] = [];
    expect(await runDoctorCommand(
      ["doctor", "--json", "--chrome"],
      (text) => mismatchOutput.push(text),
      {
        inspectChrome: async () => ({
          ok: false,
          status: "native-host-mismatch",
          action: "reinstall-placekeeper",
          extensionId: "cgegjjjhbhnfgcoipeffhogoojfoekgg",
          protocol: 1,
        }),
      },
    )).toBe(2);
    expect(JSON.stringify(JSON.parse(mismatchOutput.join("")))).not.toMatch(/Users|Library|cap=/u);
  });
});
