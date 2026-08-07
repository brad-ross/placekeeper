import { spawn } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { requestLaunch, startLaunchControlServer } from "./launch-control.js";
import type { LaunchRequest, LaunchResponse } from "./proofreader-host.js";
import { ProofreaderHost } from "./proofreader-host.js";

export interface DaemonPaths {
  readonly appSupportRoot: string;
  readonly recoveryRoot: string;
  readonly socketPath: string;
  readonly webAssetsRoot: string;
}

export function defaultDaemonPaths(): DaemonPaths {
  const appSupportRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "PDF Proofreader",
  );
  return {
    appSupportRoot,
    recoveryRoot: join(appSupportRoot, "recovery"),
    socketPath: join(appSupportRoot, "control.sock"),
    webAssetsRoot:
      process.env.PDF_PROOFREADER_WEB_ASSETS ??
      resolve(dirname(process.argv[1] ?? "."), "../web"),
  };
}

async function removeConfirmedStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => undefined);
  if (info?.isSocket() !== true) return;
  await new Promise<void>((resolveConnection) => {
    const socket = createConnection(socketPath);
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      socket.destroy();
      resolveConnection();
    });
    socket.once("error", () => {
      if (!connected) void unlink(socketPath).finally(resolveConnection);
    });
  });
}

export async function startServiceDaemon(paths = defaultDaemonPaths()): Promise<{
  readonly host: ProofreaderHost;
  close(): Promise<void>;
}> {
  await removeConfirmedStaleSocket(paths.socketPath);
  const host = await ProofreaderHost.start({
    recoveryRoot: paths.recoveryRoot,
    webAssets: { root: paths.webAssetsRoot },
  });
  try {
    const control = await startLaunchControlServer(host, paths.socketPath);
    return {
      host,
      close: async () => {
        await control.close();
        await host.close();
      },
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}

function daemonUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

export async function launchThroughDaemon(
  request: LaunchRequest,
  paths = defaultDaemonPaths(),
): Promise<LaunchResponse> {
  try {
    return await requestLaunch(paths.socketPath, request);
  } catch (error) {
    if (!daemonUnavailable(error)) throw error;
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("The proofreader launcher entry point is unavailable");
  const child = spawn(process.execPath, [entry, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PDF_PROOFREADER_WEB_ASSETS: paths.webAssetsRoot },
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    try {
      return await requestLaunch(paths.socketPath, request);
    } catch (error) {
      if (!daemonUnavailable(error)) throw error;
    }
  }
  throw new Error("The local proofreader service did not become ready");
}

export async function runServiceDaemon(paths = defaultDaemonPaths()): Promise<void> {
  const daemon = await startServiceDaemon(paths);
  await new Promise<void>((resolveSignal) => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
  await daemon.close();
}
