import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const previousName = process.platform === 'darwin' ? 'previous.app' : 'previous';
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const within = (parent, child) => { const suffix = relative(parent, child); return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)); };
async function atomicJournal(root, record) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `journal-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(root, 'journal.json'));
  // Windows does not support opening directories for fsync.
  if (process.platform !== 'win32') { const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
}
async function journal(options) {
  const record = await readFile(join(options.transactionRoot, 'journal.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!record) return undefined;
  if (record.version !== 1 || record.destination !== resolve(options.destination) || !/^[a-f0-9]{48}$/u.test(record.attempt ?? '') ||
      !['staging','retaining','activating','starting','committing','complete','retiring','restoring','restored','retirement-uncertain'].includes(record.phase) ||
      ['staged','previous','failed'].some(key => record[key] !== join(options.transactionRoot, record.attempt, key === 'previous' ? previousName : key)) ||
      record.receipt !== join(options.transactionRoot, record.attempt, 'service-ready.json') || record.shellReceipt !== join(options.transactionRoot, record.attempt, 'shell-ready.json')) throw new Error('Installation journal is invalid; preserve it for manual recovery');
  return record;
}
async function transition(options, record, phase) { record.phase = phase; await atomicJournal(options.transactionRoot, record); await options.checkpoint?.(phase, record); }
/** Caller owns the lifecycle lease and proves the exact candidate retired.
 * Recovery never copies an old recovery backup over canonical user data. */
export async function recoverInstallation(options) {
  const record = await journal(options);
  if (!record || ['complete','restored'].includes(record.phase)) return record;
  if (['starting','committing','retiring','retirement-uncertain'].includes(record.phase)) {
    await transition(options, record, 'retiring');
    try { await options.retire(record); }
    catch (error) { await transition(options, record, 'retirement-uncertain'); throw new Error(`Candidate retirement is uncertain. Keep both app versions, journal ${options.transactionRoot}, and recovery backup ${record.backupRoot}. Close the candidate and retry recovery.`, { cause: error }); }
  }
  // Intent records precede renames. The locations disambiguate a crash on
  // either side, including a crash while restoration itself is in progress.
  if (await exists(record.previous)) {
    await transition(options, record, 'restoring');
    if (await exists(record.destination)) {
      if (await exists(record.failed)) throw new Error('Ambiguous app locations; retain all copies for manual recovery');
      await rename(record.destination, record.failed);
    }
    await rename(record.previous, record.destination);
  } else if (!record.hadPrevious && ['activating','starting','committing','retiring','retirement-uncertain','restoring'].includes(record.phase) && await exists(record.destination)) {
    await transition(options, record, 'restoring'); await rename(record.destination, record.failed);
  }
  await transition(options, record, 'restored'); return record;
}
export async function activateInstallation(options) {
  if (![options.built, options.destination, options.transactionRoot, options.backupRoot].every(isAbsolute) || within(options.destination, options.transactionRoot) || within(options.transactionRoot, options.destination)) throw new Error('Installation journal must be outside the application');
  await recoverInstallation(options);
  const attempt = randomBytes(24).toString('hex');
  const base = join(options.transactionRoot, attempt);
  const record = { version: 1, attempt, destination: resolve(options.destination), candidateIdentity: options.candidateIdentity, backupRoot: options.backupRoot,
    previousLocation: options.previousLocation ?? null, hadPrevious: await exists(options.destination), staged: join(base,'staged'), previous: join(base,previousName), failed: join(base,'failed'), receipt: join(base,'service-ready.json'), shellReceipt: join(base,'shell-ready.json'), phase: 'staging' };
  await mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await transition(options, record, 'staging');
    await cp(options.built, record.staged, { recursive: true, verbatimSymlinks: true });
    await options.validate(record.staged);
    await transition(options, record, 'retaining');
    if (record.hadPrevious) await rename(record.destination, record.previous);
    await transition(options, record, 'activating');
    await rename(record.staged, record.destination);
    await options.checkpoint?.('candidate-moved', record);
    await transition(options, record, 'starting');
    await options.ready(record, () => atomicJournal(options.transactionRoot, record));
    await transition(options, record, 'committing');
    await transition(options, record, 'complete');
    return record;
  } catch (error) {
    if (!error.interrupted) await recoverInstallation({ ...options, checkpoint: undefined });
    throw error;
  }
}

async function atomicSelection(path, value) {
  await mkdir(dirname(path), { recursive:true, mode:0o700 });
  const temporary=`${path}.${randomBytes(12).toString('hex')}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(`${JSON.stringify(value)}\n`);await handle.sync();}finally{await handle.close();}
  await rename(temporary,path);
}
/** Immutable OS-owned runtimes stay in place. Only a per-user selection record
 * changes; the dispatcher and caller validate its exact artifact identity. */
export async function activateRuntimeSelection(options) {
  const { resources, selectionPath, transactionRoot, candidateIdentity, backupRoot }=options;
  if (![resources,selectionPath,transactionRoot,backupRoot].every(isAbsolute)||within(resources,transactionRoot)||within(resources,selectionPath)||! /^[a-f0-9]{64}$/u.test(candidateIdentity))throw Error('Invalid immutable runtime selection');
  await recoverRuntimeSelection(options);
  await options.validate(resources);
  const attempt=randomBytes(24).toString('hex');
  const previous=await readFile(selectionPath,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
  const record={version:1,kind:'runtime-selection',attempt,selectionPath,resources,candidateIdentity,backupRoot,previous,phase:'selecting'};
  try{
    await transition(options,record,'selecting');
    await atomicSelection(selectionPath,{version:1,resources,installArtifactIdentity:candidateIdentity,attempt});
    await transition(options,record,'starting');await options.ready(record, () => atomicJournal(options.transactionRoot, record));
    await transition(options,record,'committing');await transition(options,record,'complete');return record;
  }catch(error){if(!error.interrupted)await recoverRuntimeSelection({...options,checkpoint:undefined});throw error;}
}
export async function recoverRuntimeSelection(options) {
  const record=await readFile(join(options.transactionRoot,'journal.json'),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!record)return;
  if(record.version!==1||record.kind!=='runtime-selection'||record.selectionPath!==options.selectionPath||!isAbsolute(record.resources)||! /^[a-f0-9]{48}$/u.test(record.attempt)||!['selecting','starting','committing','complete','retiring','retirement-uncertain','restoring','restored'].includes(record.phase))throw Error('Invalid runtime activation journal; preserve for manual recovery');
  if(['complete','restored'].includes(record.phase))return record;
  if(['starting','committing','retiring','retirement-uncertain'].includes(record.phase)){
    await transition(options,record,'retiring');
    try{await options.retire(record);}catch(error){await transition(options,record,'retirement-uncertain');throw Error(`Candidate retirement uncertain; preserve runtime selections and backup ${record.backupRoot}`,{cause:error});}
  }
  await transition(options,record,'restoring');
  // A null selection explicitly means no selected runtime; the dispatcher must
  // never interpret it as a fallback to a different installation.
  await atomicSelection(record.selectionPath,record.previous);
  await transition(options,record,'restored');return record;
}
