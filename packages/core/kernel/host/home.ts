import type { Instant } from '@ferretry/std';
import { BEFORE_SUFFIX, decideHome, HOME_FORMAT, type HomeDecision, type HomeProbe } from '../contract/home.ts';
import type { HostFs } from './adapters/node-fs.ts';

/**
 * Reads what is at `FY_HOME` for `decideHome` (§9.3). Touches nothing. `underLock`: asked again once the home lock is
 * held, when a `run/` holding nothing but that lock is this daemon's own and does not make the home "not empty".
 */
export async function probeHome(fs: HostFs, home: string, underLock = false): Promise<HomeProbe> {
  try {
    const info = await fs.lstat(home);
    if (info === undefined) return { kind: 'missing' };
    if (info.kind !== 'directory') return { kind: 'io-error', message: 'it is not a folder' };
    const entries = await fs.list(home);
    const onlyLock =
      underLock &&
      entries.length === 1 &&
      entries[0] === 'run' &&
      (await fs.list(`${home}/run`)).every(entry => entry === 'daemon.lock');
    if (entries.length === 0 || onlyLock) return { kind: 'empty' };
    if (!entries.includes('home.json')) return { kind: 'no-home-json' };
    return { kind: 'home-json', text: await fs.readText(`${home}/home.json`) };
  } catch (error) {
    return { kind: 'io-error', message: error instanceof Error ? error.message : 'unknown error' };
  }
}

export type HomeOutcome =
  | { readonly kind: 'ready'; readonly created: boolean; readonly logs?: 'made' | 'tightened' }
  | { readonly kind: 'refused'; readonly decision: Extract<HomeDecision, { kind: 'refuse' }> }
  /** `logs/` is there but is not a folder of ours, or cannot be made: the daemon would log nothing, so it does not start. */
  | { readonly kind: 'logs-refused'; readonly sentence: string };

/** The folder the daemon's one log is written in: `<home>/logs/fyd.log` (`fyd.ts`). */
const LOGS_FOLDER = 'logs';

const KIND_WORDS = { file: 'a file', link: 'a link', other: 'not a folder' } as const;

/** `0700` on the folder through a descriptor opened without following a link, so a swap for a link is refused, never chmodded. */
async function setPrivateMode(fs: HostFs, path: string): Promise<void> {
  const folder = await fs.openDirectory(path);
  try {
    await folder.chmod(0o700);
  } finally {
    await folder.close();
  }
}

/**
 * `logs/` exists, as a folder only this user may enter, before anything is logged. The daemon's log lines are dropped
 * until it does, so a home that was copied or restored without it logged NOTHING and said nothing. Looked at without
 * following a link: a link or a file in its place is refused by name, never written through. A folder open to others
 * is tightened to `0700` and reported; one that cannot be made, or that this user cannot write in (the log would be
 * lost the same way), is refused with the reason.
 */
async function ensureLogs(fs: HostFs, home: string): Promise<'present' | 'made' | 'tightened' | { sentence: string }> {
  const path = `${home}/${LOGS_FOLDER}`;
  const refuse = (why: string): { sentence: string } => ({
    sentence: `${path} ${why}, so the daemon would have nowhere to write its log and did not start. Move it aside (or fix it) and start again.`,
  });
  try {
    const info = await fs.lstat(path);
    if (info === undefined) {
      await fs.mkdirp(path, 0o700);
      const made = await fs.lstat(path);
      if (made?.kind !== 'directory') return refuse('is not a folder after it was made');
      await setPrivateMode(fs, path);
      return 'made';
    }
    if (info.kind !== 'directory') return refuse(`is ${KIND_WORDS[info.kind]}, not a folder`);
    const tighten = info.mode !== undefined && (info.mode & 0o077) !== 0;
    if (tighten) await setPrivateMode(fs, path);
    // A folder this user cannot write in (owner bits without write or search, or another user's) logs nothing either.
    const ownerCanUse = tighten || info.mode === undefined || (info.mode & 0o300) === 0o300;
    if (!ownerCanUse || !(await fs.writable(path))) return refuse('is a folder this user cannot write in');
    return tighten ? 'tightened' : 'present';
  } catch (error) {
    return refuse(`could not be made (${error instanceof Error ? error.message : 'unknown error'})`);
  }
}

/**
 * §7.6 step 2: `decideHome`, then the fence. Creates the tree on an empty or missing home and writes `home.json`;
 * on every start, before anything is served, sets every `<home>-before-*` folder and every `state/<id>-before-*`
 * folder to `0700`. Anything else is refused with nothing touched.
 */
export async function openHome(fs: HostFs, home: string, createdBy: string, now: Instant): Promise<HomeOutcome> {
  // Decided again under the home lock: the reading before it is stale the moment another daemon sets the home up.
  const decision = decideHome(home, await probeHome(fs, home, true));
  if (decision.kind === 'refuse') return { kind: 'refused', decision };
  const created = decision.kind === 'create';
  if (created) {
    await fs.mkdirp(home, 0o700);
    for (const folder of ['config', 'state', 'state/kernel', 'run', 'logs'])
      await fs.mkdirp(`${home}/${folder}`, 0o700);
    await fs.writeAtomic(
      `${home}/home.json`,
      `${JSON.stringify({ format: HOME_FORMAT, createdBy, createdAt: now }, null, 2)}\n`,
      0o600,
    );
  }
  await fs.chmod(home, 0o700);
  await fenceFolders(fs, home);
  const logs = await ensureLogs(fs, home);
  if (typeof logs === 'object') return { kind: 'logs-refused', sentence: logs.sentence };
  return { kind: 'ready', created, ...(logs === 'present' ? {} : { logs }) };
}

/** Sets every fenced `-before-` folder to `0700` (§9.3 fence rule 1). */
export async function fenceFolders(fs: HostFs, home: string): Promise<readonly string[]> {
  const fenced: string[] = [];
  const slash = home.lastIndexOf('/');
  const parent = home.slice(0, slash) || '/';
  const name = home.slice(slash + 1);
  for (const entry of await fs.list(parent))
    if (entry.startsWith(`${name}-before-`) && BEFORE_SUFFIX.test(entry)) fenced.push(`${parent}/${entry}`);
  for (const entry of await fs.list(`${home}/state`))
    if (BEFORE_SUFFIX.test(entry)) fenced.push(`${home}/state/${entry}`);
  for (const folder of fenced) {
    const info = await fs.lstat(folder);
    if (info?.kind === 'directory') await fs.chmod(folder, 0o700);
  }
  return fenced;
}
