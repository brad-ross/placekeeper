import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const extensionId = 'placekeeper-local.placekeeper-vscode';
const xml = (value) => String(value).replace(/[<>&"']/gu, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);

/** Build a portable VSIX; the installed bundle retains one for manual setup. */
export async function packageVscode({ appPath, outputPath, run = execute, consume }) {
  const source = resolve(appPath, 'Contents/Resources/integrations/vscode');
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (`${manifest.publisher}.${manifest.name}` !== extensionId || typeof manifest.version !== 'string') {
    throw new Error('The bundled VS Code extension identity is invalid');
  }
  const staging = await mkdtemp(resolve(tmpdir(), 'placekeeper-vscode-update-'));
  try {
    await cp(source, resolve(staging, 'extension'), { recursive: true });
    await writeFile(resolve(staging, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/><DisplayName>Placekeeper</DisplayName><Description xml:space="preserve">Review PDFs with Placekeeper.</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}"/></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`);
    await writeFile(resolve(staging, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>');
    const archive = resolve(staging, 'placekeeper.vsix');
    await run('/usr/bin/zip', ['-q', '-r', archive, 'extension', 'extension.vsixmanifest', '[Content_Types].xml'], { cwd: staging });
    if (outputPath) await copyFile(archive, outputPath);
    if (consume) return await consume(archive, manifest);
    return { path: outputPath, version: manifest.version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Use VS Code's supported installer without changing enablement or settings. */
export async function updateVscode({ appPath, codePath, installIfMissing = false, run = execute }) {
  codePath ??= [
    resolve(homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    ...(process.env.PLACEKEEPER_HOST_PATH ?? process.env.PATH ?? '').split(':').filter(Boolean).map((directory) => resolve(directory, 'code')),
  ].find((candidate) => existsSync(candidate));
  if (codePath === undefined) return { status: 'editor-unavailable', path: resolve(appPath, 'Contents/Resources/integrations/placekeeper.vsix') };
  const { stdout } = await run(codePath, ['--list-extensions', '--show-versions']);
  const installed = stdout.split(/\r?\n/u).some((line) => line.trim().split('@')[0].toLowerCase() === extensionId);
  if (!installed && !installIfMissing) return { status: 'not-installed' };
  return packageVscode({ appPath, run, consume: async (archive, manifest) => {
    // Source reruns may change payload bytes without changing the version.
    await run(codePath, ['--install-extension', archive, '--force']);
    const verification = await run(codePath, ['--list-extensions', '--show-versions']);
    if (!verification.stdout.split(/\r?\n/u).some((line) => line.trim().toLowerCase() === `${extensionId}@${manifest.version}`.toLowerCase())) {
      throw new Error('VS Code did not report the bundled extension version after installation');
    }
    return { status: installed ? 'updated' : 'installed', version: manifest.version };
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--package' && process.argv.length === 5) {
      console.log(JSON.stringify(await packageVscode({ appPath: process.argv[3], outputPath: process.argv[4] })));
    } else {
      if (!process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN) throw new Error('VS Code setup requires daemon coordinate-host');
      if (!process.argv[2]) throw new Error('Usage: update-vscode.mjs <installed-app> [code-cli]');
      console.log(JSON.stringify(await updateVscode({ appPath: process.argv[2], codePath: process.argv[3] })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
