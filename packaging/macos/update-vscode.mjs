import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const extensionId = 'placekeeper-local.placekeeper-vscode';
const xml = (value) => String(value).replace(/[<>&"']/gu, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);

/** Use VS Code's installer, preserving its registration and extension enablement. */
export async function updateVscode({ appPath, codePath, run = execute }) {
  codePath ??= [
    resolve(homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  ].find((candidate) => existsSync(candidate));
  if (codePath === undefined) return { status: 'editor-unavailable' };
  const { stdout } = await run(codePath, ['--list-extensions', '--show-versions']);
  if (!stdout.split(/\r?\n/u).some((line) => line.trim().split('@')[0].toLowerCase() === extensionId)) {
    return { status: 'not-installed' };
  }
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
    // Source installs may change the payload without changing the version number.
    await run(codePath, ['--install-extension', archive, '--force']);
    return { status: 'updated', version: manifest.version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const appPath = process.argv[2];
  if (!appPath) throw new Error('Usage: update-vscode.mjs <installed-app> [code-cli]');
  try {
    const result = await updateVscode({ appPath, codePath: process.argv[3] });
    console.log(result.status === 'updated'
      ? `VS Code extension updated (${result.version}). Reload VS Code to load the current interface.`
      : `VS Code extension update skipped: ${result.status}.`);
  } catch (error) {
    console.error('The app is installed, but its VS Code extension update failed. Close VS Code and rerun the installer.');
    console.error(error.message);
    process.exitCode = 1;
  }
}
