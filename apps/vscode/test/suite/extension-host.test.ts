import { describe, expect, it } from "vitest";

// U8 supplies the installed VS Code/LaTeX Workshop runner. Keeping this suite
// environment-gated lets that runner exercise the real command registry while
// ordinary Vitest remains deterministic and host-free.
describe.runIf(process.env.PLACEKEEPER_EXTENSION_HOST === "1")("Placekeeper Extension Development Host", () => {
  it("activates for the serialized panel type and exposes the supported fallback commands", async () => {
    const vscode = await import("vscode");
    const commands = await vscode.commands.getCommands(true);
    expect(commands).toEqual(expect.arrayContaining([
      "placekeeper.viewPdf",
      "placekeeper.forwardSyncTex",
      "placekeeper.goToSource",
      "placekeeper.reattach",
      "placekeeper.exportReviewedPdf",
    ]));
  });
});
