export const LATEX_WORKSHOP_OWNED_SETTINGS = [
  "latex-workshop.view.pdf.viewer",
  "latex-workshop.view.pdf.external.viewer.command",
  "latex-workshop.view.pdf.external.viewer.args",
] as const;

export type LaTeXWorkshopSetting = typeof LATEX_WORKSHOP_OWNED_SETTINGS[number];
export type WorkspaceSettingValues = Readonly<Record<LaTeXWorkshopSetting, unknown>>;

export interface CompatibilitySetupRecord {
  readonly scope: "workspace";
  readonly prior: WorkspaceSettingValues;
  readonly next: WorkspaceSettingValues;
}

export function compatibilityStatus(version: string | undefined): {
  readonly status: "available" | "missing" | "incompatible";
  readonly fallbackCommandsAvailable: true;
} {
  if (version === undefined) return { status: "missing", fallbackCommandsAvailable: true };
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/u.exec(version);
  if (match === null) return { status: "incompatible", fallbackCommandsAvailable: true };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return {
    status: major > 10 || (major === 10 && minor >= 18) ? "available" : "incompatible",
    fallbackCommandsAvailable: true,
  };
}

export function previewCompatibilitySetup(
  prior: WorkspaceSettingValues,
  launcher: { readonly command: string; readonly registrationId: string },
): CompatibilitySetupRecord {
  if (launcher.command.length === 0 || !/^[A-Za-z0-9_-]{16,128}$/u.test(launcher.registrationId)) {
    throw new Error("A scoped external-launch registration is required");
  }
  return {
    scope: "workspace",
    prior: structuredClone(prior),
    next: {
      "latex-workshop.view.pdf.viewer": "external",
      "latex-workshop.view.pdf.external.viewer.command": launcher.command,
      "latex-workshop.view.pdf.external.viewer.args": [
        "--registration", launcher.registrationId,
        "--pdf", "%PDF%",
        "--line", "%LINE%",
        "--tex", "%TEX%",
      ],
    },
  };
}

export function restoreCompatibilitySettings(
  current: WorkspaceSettingValues,
  setup: CompatibilitySetupRecord,
): Partial<Record<LaTeXWorkshopSetting, unknown>> {
  const restoration: Partial<Record<LaTeXWorkshopSetting, unknown>> = {};
  for (const setting of LATEX_WORKSHOP_OWNED_SETTINGS) {
    if (sameValue(current[setting], setup.next[setting])) restoration[setting] = setup.prior[setting];
  }
  return restoration;
}

export function compatibilityPrior(
  current: WorkspaceSettingValues,
  existing: CompatibilitySetupRecord | undefined,
): WorkspaceSettingValues {
  if (existing === undefined) return structuredClone(current);
  return Object.fromEntries(LATEX_WORKSHOP_OWNED_SETTINGS.map((setting) => [
    setting,
    sameValue(current[setting], existing.next[setting])
      ? existing.prior[setting]
      : current[setting],
  ])) as unknown as WorkspaceSettingValues;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
