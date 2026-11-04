import { readFile } from 'node:fs/promises';

export const integrationHosts = ['chrome', 'vscode', 'codex'] as const;
export type IntegrationHost = typeof integrationHosts[number];
interface SetupDialog { title: string; message: string; detail?: string; buttons: string[]; defaultId: number; cancelId: number }
export function createIntegrationSetup(options: {
    statePath: string;
    isolated: boolean;
    present(dialog: SetupDialog): Promise<number>;
    setup(choices: Record<IntegrationHost, 'setup' | 'skip'>): Promise<{ outcomes: { host: string; status: string; message: string }[] }>;
}) {
    let running: Promise<void> | undefined;
    const show = async () => {
        if (options.isolated) return;
        const choices = {} as Record<IntegrationHost, 'setup' | 'skip'>;
        for (const host of integrationHosts) {
            const response = await options.present({title:'Optional integrations',message:`Set up ${host === 'vscode' ? 'VS Code' : host === 'chrome' ? 'Chrome' : 'Codex'}?`,detail:'You can skip each integration and open PDFs normally. Revisit these choices from Help → Set Up Integrations. Setup may require host installation, permission, trust or restart.',buttons:['Skip','Set Up'],defaultId:0,cancelId:0});
            choices[host] = response === 1 ? 'setup' : 'skip';
        }
        try {
            const result = await options.setup(choices);
            const active = result.outcomes.filter(item=>item.status !== 'skipped');
            if (active.length) await options.present({title:'Integration setup',message:'Integration setup results',detail:active.map(item=>`${item.host}: ${item.status}. ${item.message}`).join('\n\n'),buttons:['Done'],defaultId:0,cancelId:0});
        } catch(error) {
            await options.present({title:'Integration setup',message:'Integration setup could not finish. PDFs can still be opened.',detail:String(error),buttons:['Done'],defaultId:0,cancelId:0});
        }
    };
    const open = () => running ??= show().finally(()=>{running=undefined;});
    return {open, async firstLaunch() {
        if(options.isolated) return;
        const previous = await readFile(options.statePath,'utf8').then(text => JSON.parse(text) as {choices?: Partial<Record<IntegrationHost, boolean>>}, (error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
        if(!previous) { await open(); return; }
        if (integrationHosts.some(host=>previous.choices?.[host] === true)) {
            const choices = Object.fromEntries(integrationHosts.map(host=>[host,previous.choices?.[host] === true ? 'setup' : 'skip'])) as Record<IntegrationHost,'setup'|'skip'>;
            const result = await options.setup(choices);
            const changed = result.outcomes.filter(item => item.status === 'failed' || ('registration' in item && item.registration !== 'current' && item.status !== 'skipped'));
            if(changed.length) await options.present({title:'Integration setup',message:'Integration refresh needs host action',detail:changed.map(item=>`${item.host}: ${item.status}. ${item.message}`).join('\n\n'),buttons:['Done'],defaultId:0,cancelId:0});
        }
    }};
}
