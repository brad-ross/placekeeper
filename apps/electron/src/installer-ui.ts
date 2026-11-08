import { app, dialog, shell } from 'electron';
import { lstat, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createIntegrationSetup } from './integration-setup.js';
import { pathToFileURL } from 'node:url';

export interface InstallerRequest { candidate: string; uninstall: boolean; destination?: string; immutable: boolean; isolatedRoot?: string; port?: number }
export function parseInstallerRequest(args: readonly string[]): InstallerRequest | undefined {
    if (!args.includes('--placekeeper-install') && !args.includes('--placekeeper-uninstall')) return undefined;
    if (!['--placekeeper-install','--placekeeper-uninstall'].includes(args[0] ?? '') || !args[1] || !isAbsolute(args[1])) throw Error('Invalid installer candidate');
    const request: InstallerRequest = { candidate: args[1], immutable: false, uninstall: args[0] === '--placekeeper-uninstall' };
    for (let index = 2; index < args.length; index++) {
        const flag = args[index];
        if (flag === '--immutable-runtime') { request.immutable = true; continue; }
        const value = args[++index];
        if (flag === '--http-port') { const port = Number(value); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid installer port'); request.port = port; }
        else if (flag === '--destination' || flag === '--isolated-test-root' || flag === '--placekeeper-uninstall-target') { if (!value || !isAbsolute(value) || value.includes('\0')) throw Error('Invalid installer path'); if (flag === '--destination' || flag === '--placekeeper-uninstall-target') { request.destination = value; if(flag === '--placekeeper-uninstall-target')request.uninstall=true; } else request.isolatedRoot = value; }
        else throw Error('Unknown installer option');
    }
    if(request.immutable&&request.uninstall)throw Error('Remove the Debian package through your OS package manager; runtime versions are retained for active sessions and recovery');
    if ((request.port === undefined) !== (request.isolatedRoot === undefined)) throw Error('An isolated installer requires both port and state root');
    return request;
}

/** Set before Electron readiness, without taking the incumbent's lock/profile. */
export function isolateInstallerProfile(): string {
    const profile = mkdtempSync(join(tmpdir(), 'placekeeper-installer-'));
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    app.setName('Placekeeper Installer');
    app.setPath('userData', profile);
    return profile;
}
export async function runInstallerUI(request: InstallerRequest, profile: string): Promise<void> {
    let failed=false;
    try {
        await app.whenReady();
        const root = join(request.candidate, process.platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop');
        const { runInstaller, resolveInstallLayout } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'installer/installer-entry.mjs')).href);
        request.destination ??= resolveInstallLayout().destination;
        const existing=await lstat(request.destination!).then(value=>value.isDirectory(),(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;});
        const buttons=request.uninstall?['Cancel','Uninstall']:['Cancel','Install',...(existing&&!request.immutable?['Uninstall existing installation']:[])];
        const proceed = await dialog.showMessageBox({ type: 'question', title: request.uninstall?'Uninstall Placekeeper':'Install Placekeeper', message: request.uninstall?'Uninstall this version of Placekeeper?':'Install this version of Placekeeper?', detail: 'Your documents, annotations, drafts and settings will be preserved. The installer keeps the previous app until the new version passes its startup checks.', buttons, defaultId: 1, cancelId: 0 });
        if (proceed.response === 0) return;
        if (proceed.response === 2) request.uninstall=true;
        const verb=request.uninstall?'Uninstall':'Install';
        const result = await runInstaller(request, async () => {
            const decision = await dialog.showMessageBox({ type: 'warning', title: 'Close reviews to install?', message: `${verb === 'Install' ? 'Installing' : 'Uninstalling'} Placekeeper will close active reviews.`, detail: 'Pending edits and recoverable drafts will be protected before reviews close. Cancel keeps the current installation and reviews available.', buttons: ['Cancel', 'Protect work and close reviews'], defaultId: 0, cancelId: 0 });
            return decision.response === 1;
        });
        if (process.platform === 'win32' && !request.uninstall && request.port === undefined) {
            const { registerWindowsInstallation }=await import(/* @vite-ignore */ pathToFileURL(join(root, 'installer/windows-registration.mjs')).href);
            await registerWindowsInstallation(result.destination, (path: string, options: Electron.ShortcutDetails) => shell.writeShortcutLink(path, 'create', options));
        }
        if (!request.uninstall && !request.isolatedRoot) {
          try {
            const installedRoot = request.immutable ? root : join(result.destination, process.platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop');
            const helper = await import(/* @vite-ignore */ pathToFileURL(join(installedRoot, 'installer/setup-integrations.mjs')).href);
            await createIntegrationSetup({statePath:helper.integrationStatePath(),isolated:false,
                present: async options => (await dialog.showMessageBox(options)).response,
                setup: choices => helper.setupIntegrations({resources:installedRoot,choices})}).open();
          } catch(error) { await dialog.showMessageBox({type:'warning',title:'Optional integration setup',message:'Placekeeper is installed. Optional integration setup needs attention.',detail:`${String(error)}. Revisit Help → Set Up Integrations after opening Placekeeper.`,buttons:['Continue']}); }
        }
        const retainedDetail=result.retainedResources?.length?` Modified registrations or shortcuts were preserved: ${result.retainedResources.join('; ')}.`:'';
        await dialog.showMessageBox({ type: 'info', title: `Placekeeper ${request.uninstall?'uninstalled':'installed'}`, message: request.uninstall?'Placekeeper was uninstalled.':'Placekeeper is ready.', detail: request.uninstall && process.platform==='darwin' ? `The installed bundle was moved to a complete retained recovery app beside the installation in .placekeeper-install-transactions. The verified recovery backup remains in your Placekeeper support folder. Documents, settings and recovery data are preserved.` : request.uninstall ? `App-owned files and registrations were removed from ${result.destination}. Unknown files remain in place. A complete retained app remains beside the installation in .placekeeper-install-transactions; the verified recovery backup remains in your Placekeeper support folder. Documents, settings and recovery data are preserved. The temporary uninstall runtime at ${request.candidate} can be removed after this installer closes.${retainedDetail}` : `Installed at ${result.destination}. Recovery backups are retained. Optional integrations can be configured from Placekeeper.`, buttons: ['Done'] });
    } catch (error) {
        failed=true;
        console.error('[Placekeeper installer] Startup or installation failed', error);
        const message=error&&typeof error==='object'&&'userMessage' in error&&typeof error.userMessage==='string'?error.userMessage:error instanceof Error?error.message:String(error);
        dialog.showErrorBox('Placekeeper installation stopped', message);
    } finally {
        await rm(profile, { recursive: true, force: true }).catch(error => console.error(error));
        if(failed)app.exit(2);else app.quit();
    }
}
