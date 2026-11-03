import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

/** Resolve JavaScript behind npm/Corepack's Windows shim without cmd.exe. */
export async function packageManagerInvocation(environment = process.env, platform = process.platform) {
  if (environment.PLACEKEEPER_PNPM_CLI) return { command: process.execPath, prefix: [environment.PLACEKEEPER_PNPM_CLI] };
  if (platform !== 'win32') return { command: 'pnpm', prefix: [] };
  const path = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of path.split(delimiter)) {
    const executable = join(directory, 'pnpm.exe');
    if (await access(executable).then(() => true, () => false)) return { command: executable, prefix: [] };
    const shim = join(directory, 'pnpm.cmd');
    if (!await access(shim).then(() => true, () => false)) continue;
    const base = dirname(await realpath(shim));
    for (const entry of ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/corepack/dist/pnpm.js', 'pnpm.cjs']) {
      const script = join(base, entry);
      if (await access(script).then(() => true, () => false)) return { command: process.execPath, prefix: [script] };
    }
  }
  throw new Error('Install pnpm 11.16.0 with npm, or set PLACEKEEPER_PNPM_CLI to its JavaScript entry point');
}
