import type { spawn } from 'node:child_process';
export interface InstallerOptions {
  candidate: string;
  destination?: string;
  immutable?: boolean;
  uninstall?: boolean;
  isolatedRoot?: string;
  port?: number;
}
export function runInstaller(options: InstallerOptions, consent: () => boolean | Promise<boolean>, invoke?: typeof spawn): Promise<{
  destination: string;
  output: string;
  retainedResources: string[];
}>;
export function launchInstaller(candidate: string, args?: string[], invoke?: typeof spawn): Promise<number>;
export { resolveInstallLayout } from './install-layout.js';
