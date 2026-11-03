import { execFile } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setupCodex } from './setup-integrations.mjs';

/** Setup is explicit and never edits the Codex cache or grants host trust. */
export async function setupPortableCodex({ resources, destination, run = promisify(execFile) }) {
  resources = resolve(resources);
  const manifest = JSON.parse(await readFile(join(resources, 'runtime-manifest.json'), 'utf8'));
  const identity = manifest.installArtifactIdentity;
  if (!/^[a-f0-9]{64}$/u.test(identity ?? '')) throw new Error('The installed runtime has no artifact identity');
  destination ??= join(homedir(), '.placekeeper', 'codex', identity);
  const receipt = `${destination}.receipt.json`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const launcher = join(resources, `bin/placekeeper${suffix}`);
  if (!await lstat(receipt).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    const { stdout } = await run(launcher, ['integration-registration', 'codex', '--receipt', receipt, '--destination', destination,
      '--node', join(resources, `node/bin/node${suffix}`), '--server', join(resources, 'codex-mcp/server.js'), '--launcher', launcher]);
    const result = JSON.parse(stdout);
    if (result.ok !== true || result.status !== 'registered') throw new Error('Codex plugin setup did not return a registration receipt');
  } else {
    // An existing receipt might describe an edited or incomplete registration.
    // Preserve it and let the owner inspect it rather than silently repairing.
    const owned = JSON.parse(await readFile(receipt, 'utf8'));
    if (owned.installationId !== identity || owned.schemaVersion !== 1 || !Array.isArray(owned.files) || owned.files.length === 0) throw new Error('Inspect the retained Codex registration receipt before retrying setup');
    const expected = new Set([join(destination, '.agents/plugins/marketplace.json')]);
    async function inventory(relative = '') {
      for (const entry of await readdir(join(resources, 'integrations/codex-plugin-template', relative), { withFileTypes: true })) {
        const suffix = join(relative, entry.name);
        if (entry.isDirectory()) await inventory(suffix);
        else if (entry.isFile() && suffix.replaceAll('\\', '/') !== 'scripts/mcp.sh') expected.add(join(destination, 'codex-plugin', suffix));
        else if (!entry.isFile()) throw new Error('Unexpected plugin template asset');
      }
    }
    await inventory();
    if (expected.size !== owned.files.length || owned.files.some(file => !expected.delete(file.path)) || expected.size !== 0) throw new Error('Codex registration is incomplete; inspect its ownership receipt before retrying setup');
    const { createHash } = await import('node:crypto');
    for (const file of owned.files) {
      const info = await lstat(file.path);
      if (!info.isFile() || info.dev !== file.device || info.ino !== file.inode || createHash('sha256').update(await readFile(file.path)).digest('hex') !== file.sha256) throw new Error('The Codex registration changed; existing files were preserved. Inspect its ownership receipt before retrying setup.');
    }
  }
  return setupCodex({ appPath: resources, marketplacePath: destination, marketplaceIdentity: `placekeeper-${identity}`, run });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await setupPortableCodex({ resources: resolve(import.meta.dirname, '..'), destination: process.argv[2] });
    console.log(result.message);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
