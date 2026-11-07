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
  | { readonly kind: 'ready'; readonly created: boolean }
  | { readonly kind: 'refused'; readonly decision: Extract<HomeDecision, { kind: 'refuse' }> };

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
  return { kind: 'ready', created };
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
