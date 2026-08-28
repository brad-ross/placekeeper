import { describe, expect, it } from "vitest";
import {
  LATEX_WORKSHOP_OWNED_SETTINGS,
  compatibilityStatus,
  previewCompatibilitySetup,
  restoreCompatibilitySettings,
} from "../src/latex-workshop-bridge.js";

describe("LaTeX Workshop compatibility bridge", () => {
  it.each([
    [undefined, "missing"],
    ["9.9.0", "incompatible"],
    ["10.18.2", "available"],
  ] as const)("reports %s as %s without disabling Placekeeper commands", (version, status) => {
    expect(compatibilityStatus(version)).toEqual({ status, fallbackCommandsAvailable: true });
  });

  it("previews exact workspace-scoped values and remembers prior values", () => {
    const prior = {
      "latex-workshop.view.pdf.viewer": "tab",
      "latex-workshop.view.pdf.external.viewer.command": "/manual/viewer",
      "latex-workshop.view.pdf.external.viewer.args": ["%PDF%"],
    };
    const preview = previewCompatibilitySetup(prior, {
      command: "/private/placekeeper-vscode-launch",
      registrationId: "registration_identifier_1234",
    });
    expect(preview.scope).toBe("workspace");
    expect(preview.prior).toEqual(prior);
    expect(preview.next).toEqual({
      "latex-workshop.view.pdf.viewer": "external",
      "latex-workshop.view.pdf.external.viewer.command": "/private/placekeeper-vscode-launch",
      "latex-workshop.view.pdf.external.viewer.args": [
        "--registration", "registration_identifier_1234", "--pdf", "%PDF%",
        "--line", "%LINE%", "--tex", "%TEX%",
      ],
    });
    expect(Object.keys(preview.next)).toEqual([...LATEX_WORKSHOP_OWNED_SETTINGS]);
  });

  it("restores only settings that still contain Placekeeper-owned values", () => {
    const setup = previewCompatibilitySetup({
      "latex-workshop.view.pdf.viewer": "tab",
      "latex-workshop.view.pdf.external.viewer.command": undefined,
      "latex-workshop.view.pdf.external.viewer.args": undefined,
    }, { command: "/placekeeper", registrationId: "registration_identifier_1234" });
    const current = { ...setup.next, "latex-workshop.view.pdf.viewer": "browser" };
    expect(restoreCompatibilitySettings(current, setup)).toEqual({
      "latex-workshop.view.pdf.external.viewer.command": undefined,
      "latex-workshop.view.pdf.external.viewer.args": undefined,
    });
  });
});
