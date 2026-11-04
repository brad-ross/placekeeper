import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface PlatformLocationOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function platformPath(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolvePlatformLocations(options: PlatformLocationOptions = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  const path = platformPath(platform);
  const absoluteOverride = (value: string | undefined) =>
    value !== undefined && path.isAbsolute(value) && !value.includes("\0") ? value : undefined;
  const appSupportRoot = platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Placekeeper")
    : platform === "win32"
      ? path.join(absoluteOverride(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"), "Placekeeper")
      : path.join(absoluteOverride(env.XDG_STATE_HOME) ?? path.join(home, ".local", "state"), "placekeeper");
  return {
    appSupportRoot,
    recoveryRoot: path.join(appSupportRoot, "recovery"),
    recoveryBackupRoot: path.join(appSupportRoot, "installer"),
    windowPreferencesRoot: path.join(appSupportRoot, "electron"),
    lifecycleLockPath: path.join(appSupportRoot, "lifecycle.lock"),
    socketPath: path.join(appSupportRoot, "control.sock"),
  };
}

export function inheritedProcessPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const key = platform === "win32" ? Object.keys(env).find((name) => name.toUpperCase() === "PATH") : "PATH";
  return key === undefined ? undefined : env[key];
}

/** Keep tool processes independent of host-specific Node/Electron settings. */
export function subprocessEnvironment(
  platform: NodeJS.Platform = process.platform,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (platform === "win32") {
    for (const name of Object.keys(inherited)) {
      if (["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"].includes(name.toUpperCase())) {
        env[name] = inherited[name];
      }
    }
  }
  return { ...env, PATH: inheritedProcessPath(platform, inherited) ?? (platform === "win32" ? "" : "/usr/bin:/bin"), LC_ALL: "C", LANG: "C" };
}
