import { desktopAssetNames } from '../../packages/core/src/desktop-release.js';
import { MakerZIP } from '@electron-forge/maker-zip';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from './package-assets.js';
import { makeMacInstaller } from './macos-installer.js';

const here=dirname(fileURLToPath(import.meta.url));
export const NSIS_VERSION='v3.11';
export async function runNativeTool(command: string,args: string[]): Promise<void> {
  await new Promise<void>((accept,reject)=>{const child=spawn(command,args,{stdio:'inherit',shell:false});child.once('error',reject);child.once('exit',code=>code===0?accept():reject(Error(`${command} exited with ${code}`)));});
}
export async function makeDebian(candidate: string, output: string, version: string, arch: string, run=runNativeTool): Promise<string> {
  if (arch!=='x64') throw Error('Debian installers support x64');
  const runtime=join(candidate,'resources/desktop');
  const manifest=JSON.parse(await readFile(join(runtime,'runtime-manifest.json'),'utf8')) as { installArtifactIdentity: string };
  const identity=manifest.installArtifactIdentity;
  if (!/^[a-f0-9]{64}$/u.test(identity)) throw Error('Invalid runtime identity');
  const stage=join(output,'deb-staging'); await rm(stage,{recursive:true,force:true});
  const payload=join(stage,'usr/lib/placekeeper/payload');
  const bootstrap=join(stage,'usr/lib/placekeeper/bootstrap');
  await mkdir(payload,{recursive:true}); await mkdir(bootstrap,{recursive:true});
  await mkdir(join(stage,'usr/bin'),{recursive:true});
  await mkdir(join(stage,'usr/share/applications'),{recursive:true});
  await mkdir(join(stage,'usr/share/icons/hicolor/256x256/apps'),{recursive:true});
  await mkdir(join(stage,'DEBIAN'));
  await run('tar',['-czf',join(payload,'runtime.tar.gz'),'-C',candidate,'.']);
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(join(payload,'runtime.tar.gz'))) hash.update(chunk);
  await writeFile(join(payload,'runtime.tar.gz.sha256'),`${hash.digest('hex')}  runtime.tar.gz\n`);
  await writeFile(join(payload,'identity'),`${identity}\n`);
  await copyFile(join(runtime,'node/bin/node'),join(bootstrap,'node'));
  for (const name of ['linux-dispatcher.mjs','launcher.mjs']) await copyFile(join(here,name),join(bootstrap,name));
  for (const [source,target] of [['placekeeper-dispatcher','placekeeper'],['placekeeper-chrome-dispatcher','placekeeper-chrome-native-host'],['placekeeper-vscode-dispatcher','placekeeper-vscode']]) await copyFile(join(runtime,'bin',source!),join(stage,'usr/bin',target!));
  await copyFile(resolve(here,'../macos/icon/Placekeeper.iconset/icon_256x256.png'),join(stage,'usr/share/icons/hicolor/256x256/apps/placekeeper.png'));
  await writeFile(join(stage,'usr/share/applications/placekeeper.desktop'),'[Desktop Entry]\nType=Application\nName=Placekeeper\nComment=Review PDF documents\nExec=/usr/bin/placekeeper %U\nIcon=placekeeper\nTerminal=false\nCategories=Office;Viewer;\nMimeType=application/pdf;x-scheme-handler/placekeeper;x-scheme-handler/placekeeper-navigation;\n');
  await writeFile(join(stage,'DEBIAN/control'),`Package: placekeeper\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Brad Ross\nDepends: libc6, libnss3, libatk1.0-0, libatk-bridge2.0-0, libcups2, libdrm2, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libgbm1, libasound2, libgtk-3-0, libx11-6, libxcb1, libxext6, libxss1, libxtst6, libglib2.0-0, util-linux\nDescription: Placekeeper PDF review\n Installed runtime versions are retained for active sessions and recovery.\n`);
  await cp(join(here,'debian-lifecycle.sh'),join(stage,'DEBIAN/postinst'));
  await cp(join(here,'debian-lifecycle.sh'),join(stage,'DEBIAN/prerm'));
  const { chmod }=await import('node:fs/promises');
  await chmod(join(stage,'DEBIAN/postinst'),0o755);await chmod(join(stage,'DEBIAN/prerm'),0o755);
  const file=join(output,desktopAssetNames(version)['linux-x64']);
  await run('dpkg-deb',['--root-owner-group','--build',stage,file]);
  return file;
}

/** Reuse Forge's existing base implementation; none of ZIP/Squirrel's make
 * behavior runs. Every supported artifact has a controlled native entrypoint. */
export class GuardedInstallerMaker extends MakerZIP {
  override name='placekeeper-guarded-installers';
  override defaultPlatforms: MakerZIP['defaultPlatforms']=['darwin','win32','linux'];
  override isSupportedOnCurrentPlatform(): boolean { return ['darwin','win32','linux'].includes(process.platform); }
  override async make({dir,makeDir,appName,packageJSON,targetArch,targetPlatform}: Parameters<MakerZIP['make']>[0]): Promise<string[]> {
    if (process.platform!==targetPlatform) throw Error('Build installers on their native OS');
    const output=join(makeDir,'guarded',targetPlatform,targetArch);
    await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
    const version=String(packageJSON.version);
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version)) throw Error('Invalid installer version');
    if (targetPlatform==='darwin') return [await makeMacInstaller(join(dir,`${appName}.app`),output,version,targetArch,runNativeTool)];
    if (targetPlatform==='linux') return [await makeDebian(dir,output,version,targetArch)];
    if (targetArch!=='x64') throw Error('Windows installers support x64');
    const makensis=process.env.PLACEKEEPER_MAKENSIS ?? 'makensis.exe';
    const installed=await promisify(execFile)(makensis,['/VERSION'],{encoding:'utf8'});
    if (installed.stdout.trim()!==NSIS_VERSION) throw Error(`Windows installers require NSIS ${NSIS_VERSION}`);
    const file=join(output,desktopAssetNames(version)['win32-x64']);
    const candidate=join(output,'windows-candidate');await cp(dir,candidate,{recursive:true});
    const owned=(await inventory(candidate)).map(file=>file.path);
    await writeFile(join(candidate,'installation-files.json'),JSON.stringify({version:1,files:[...owned,'Uninstall.exe','installation-files.json','installation-registration.json']})+'\n');
    await runNativeTool(makensis,[`/DCANDIDATE=${candidate}`,`/DOUTPUT=${file}`,join(here,'windows/setup.nsi')]);
    await writeFile(join(output,'installer-tools.json'),JSON.stringify({nsis:NSIS_VERSION})+'\n');
    return [file];
  }
}
