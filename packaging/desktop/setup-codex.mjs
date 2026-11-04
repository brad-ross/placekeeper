import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIntegrations } from './setup-integrations.mjs';

/** Prepare owned payloads; Codex itself owns installation, enablement and trust. */
export async function setupPortableCodex({resources, statePath, home, run}) {
  const result = await setupIntegrations({resources:resolve(resources),statePath,home,run,choices:{chrome:'skip',vscode:'skip',codex:'setup'}});
  const outcome = result.outcomes.find(item=>item.host==='codex');
  if(outcome.status==='failed') throw Error(outcome.message);
  return outcome;
}
if(process.argv[1] && await realpath(process.argv[1]).catch(()=>undefined)===await realpath(fileURLToPath(import.meta.url))) {
  try { console.log((await setupPortableCodex({resources:resolve(import.meta.dirname,'..')})).message); }
  catch(error) {console.error(error.message);process.exitCode=2;}
}
