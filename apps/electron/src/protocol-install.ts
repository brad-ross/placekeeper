/** Protocol registration belongs to explicit Squirrel installer events. Normal
 * app launches, development, and isolated tests never write OS associations. */
export const DESKTOP_URL_SCHEMES = ["placekeeper", "placekeeper-navigation"] as const;
interface ProtocolApplication {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string, executable: string, args: string[]): boolean;
  removeAsDefaultProtocolClient(scheme: string, executable: string, args: string[]): boolean;
}
export function handleWindowsProtocolInstall(app: ProtocolApplication, context: {
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  readonly executable: string;
}): { readonly handled: boolean; readonly exitCode: number } {
  const events = context.argv.filter(value => /^--squirrel-(install|updated|uninstall|obsolete)$/u.test(value));
  if (context.platform !== "win32" || events.length === 0) return { handled: false, exitCode: 0 };
  if (events.length !== 1) return { handled: true, exitCode: 1 };
  if (!app.isPackaged || events[0] === "--squirrel-obsolete") return { handled: true, exitCode: 0 };
  try {
    if (events[0] === "--squirrel-uninstall") {
      // Electron removes a handler only if its command still matches this app;
      // a user's replacement handler is retained. False is therefore benign.
      for (const scheme of DESKTOP_URL_SCHEMES) app.removeAsDefaultProtocolClient(scheme, context.executable, []);
      return { handled: true, exitCode: 0 };
    }
    let registered = true;
    for (const scheme of DESKTOP_URL_SCHEMES) {
      if (!app.setAsDefaultProtocolClient(scheme, context.executable, [])) registered = false;
    }
    return { handled: true, exitCode: registered ? 0 : 1 };
  } catch { return { handled: true, exitCode: 1 }; }
}
