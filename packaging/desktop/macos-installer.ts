import { desktopAssetNames, desktopTarget } from '../../packages/core/src/desktop-release.js';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A DMG contains a controlled installer, never an Applications drag target.
 * Candidate code resources stay complete; ad-hoc signatures provide execution
 * integrity, without claiming Developer ID signing or notarization. */
export async function makeMacInstaller(candidate: string, output: string, version: string, arch: string, run: (command: string, args: string[]) => Promise<void>): Promise<string> {
  const wrapper = join(output, 'Install Placekeeper.app');
  const contents = join(wrapper, 'Contents');
  const embedded = join(contents, 'Resources', 'Placekeeper.app');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await run('/usr/bin/ditto', ['--rsrc','--extattr','--acl','--qtn',candidate, embedded]);
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.placekeeper.installer</string><key>CFBundleName</key><string>Install Placekeeper</string><key>CFBundleDisplayName</key><string>Install Placekeeper</string><key>CFBundleExecutable</key><string>install</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
  await writeFile(join(contents, 'MacOS/install'), '#!/bin/sh\nset -eu\ncontents=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\ncandidate="$contents/Resources/Placekeeper.app"\nexec "$candidate/Contents/MacOS/PlacekeeperDesktop" --placekeeper-install "$candidate" "$@"\n', { mode: 0o755 });
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', embedded]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', wrapper]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', wrapper]);
  await writeFile(join(output, 'Read Me.txt'), 'Open Install Placekeeper to install or upgrade. The installer protects pending work and asks before closing active reviews. If macOS blocks this unnotarized build, review the named app in System Settings → Privacy & Security and retry if macOS offers approval. The installer keeps the old app until the new version passes its startup checks and saves a separate recovery backup for your work.\n');
  const target=desktopTarget('darwin',arch);
  if(!target)throw Error('Unsupported macOS installer architecture');
  const dmg = join(output, desktopAssetNames(version)[target]);
  // Source directory must not contain the output image while hdiutil walks it.
  const source = join(output, 'dmg-contents');
  await mkdir(source);
  await run('/usr/bin/ditto', ['--rsrc','--extattr','--acl','--qtn',wrapper, join(source, 'Install Placekeeper.app')]);
  await cp(join(output, 'Read Me.txt'), join(source, 'Read Me.txt'));
  await run('/usr/bin/hdiutil', ['create', '-volname', 'Install Placekeeper', '-srcfolder', source, '-format', 'UDZO', '-ov', dmg]);
  return dmg;
}
