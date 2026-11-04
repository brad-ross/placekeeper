/** Registration runs only after guarded activation, never on ordinary launch.
 * PDF appears in Open With; its default association is never assigned. */
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
  const events = context.argv.filter(value => ['--placekeeper-register-protocols', '--placekeeper-unregister-protocols'].includes(value));
  if (context.platform !== "win32" || events.length === 0) return { handled: false, exitCode: 0 };
  if (events.length !== 1 || !app.isPackaged) return { handled: true, exitCode: 1 };
  try {
    if (events[0] === '--placekeeper-unregister-protocols') {
      for (const scheme of DESKTOP_URL_SCHEMES) app.removeAsDefaultProtocolClient(scheme, context.executable, []);
      return { handled: true, exitCode: 0 };
    }
    let registered = true;
    for (const scheme of DESKTOP_URL_SCHEMES) if (!app.setAsDefaultProtocolClient(scheme, context.executable, [])) registered = false;
    return { handled: true, exitCode: registered ? 0 : 1 };
  } catch { return { handled: true, exitCode: 1 }; }
}
