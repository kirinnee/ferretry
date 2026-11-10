import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { internalRootPins, PINNED_KEY_PATHS, privateGuardOf } from '../../../host/fence-guard.ts';
import { type PrivateSnapshot, privateIndexOf } from '../../../host/fence-index.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A root's private guard is the snapshot's keys less the root's OWN places, and it is never a copy of every key: each
 * ferret's session folder is itself a place, so a copy per session root grew as the square of the sessions (the preview
 * daemon held 2.8 GB with ~4,700 session folders after a boot sweep reached every one). These pin both halves: the
 * answers are exactly what the copy answered, and a session root's guard holds no set of its own the size of the index.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);
const SESSIONS = 60;

async function home(): Promise<{ readonly home: string; readonly sessions: string }> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-scale-`));
  parents.push(parent);
  const root = `${parent}/home`;
  const sessions = `${root}/state/ferrets/sessions`;
  await mkdir(`${root}/state/logins/credentials/L1`, { recursive: true });
  await writeFile(`${root}/state/logins/credentials/L1/auth.json`, 'private');
  for (let at = 0; at < SESSIONS; at += 1) {
    await mkdir(`${sessions}/s${String(at)}/turns`, { recursive: true });
    // Every other session still holds its credential; the rest ended and it was removed.
    if (at % 2 === 0) await writeFile(`${sessions}/s${String(at)}/environment.json`, `{"FY_TOKEN":"x${String(at)}"}`);
  }
  // One credential under two places (a hard link): s1's own place and s0's share a key, so s1's root must still guard it.
  await link(`${sessions}/s0/environment.json`, `${sessions}/s1/environment.json`);
  return { home: root, sessions };
}

/** The guard's keys as the copy made them: every place that is not nested with `base`, by name. */
function copiedKeys(snapshot: PrivateSnapshot, base: string): ReadonlySet<string> {
  const below = (outer: string, inner: string): boolean =>
    inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  return new Set(
    snapshot.places.filter(place => !(below(place.path, base) || below(base, place.path))).map(place => place.key),
  );
}

describe('PF-scale a root guard answers as the copy did, without copying the index per root', () => {
  test('PF-scale every key is held exactly as the copied set held it, for every kind of base', async () => {
    const { home: root, sessions } = await home();
    const real = await realpath(root);
    const snapshot = await privateIndexOf(REAL, real, {
      pins: entries => [...PINNED_KEY_PATHS, ...internalRootPins(entries)],
      private: LIST,
    }).snapshot();
    const bases = [
      ...Array.from({ length: SESSIONS }, (_, at) => `${sessions}/s${String(at)}`),
      sessions,
      `${real}/state/logins/credentials/L1`,
      `${real}/state/codex/agent-homes/F1`,
      real,
      '/',
    ];
    const asked = [...new Set(snapshot.places.map(place => place.key)), '0:0', 'not-a-key'];
    for (const base of bases) {
      const guard = await privateGuardOf(REAL, root, base, LIST);
      const copied = copiedKeys(snapshot, base);
      expect({ base, size: guard.keys.size }).toEqual({ base, size: copied.size });
      for (const key of asked)
        expect({ base, key, held: guard.keys.has(key) }).toEqual({ base, key, held: copied.has(key) });
    }
  });

  test('PF-scale a credential shared with another session stays guarded through the session that also holds it', async () => {
    const { home: root, sessions } = await home();
    const real = await realpath(root);
    const snapshot = await privateIndexOf(REAL, real, {
      pins: entries => [...PINNED_KEY_PATHS, ...internalRootPins(entries)],
      private: LIST,
    }).snapshot();
    const shared = snapshot.places.find(place => place.path === `${real}/state/ferrets/sessions/s1/environment.json`);
    const own = snapshot.places.find(place => place.path === `${real}/state/ferrets/sessions/s2/environment.json`);
    expect(shared).toBeDefined();
    expect(own).toBeDefined();
    const s1 = await privateGuardOf(REAL, root, `${sessions}/s1`, LIST);
    const s2 = await privateGuardOf(REAL, root, `${sessions}/s2`, LIST);
    // s1's file is also s0's: held. s2's own file is its own: not held through s2, held through s1.
    expect(s1.keys.has(shared?.key ?? '')).toBe(true);
    expect(s2.keys.has(own?.key ?? '')).toBe(false);
    expect(s1.keys.has(own?.key ?? '')).toBe(true);
  });

  test('PF-scale a session root holds no set of its own: every session guard reads the one kept set', async () => {
    const { home: root, sessions } = await home();
    const guards = await Promise.all(
      Array.from(
        { length: SESSIONS },
        async (_, at) => await privateGuardOf(REAL, root, `${sessions}/s${String(at)}`, LIST),
      ),
    );
    // A copy is a Set the size of the index; the guard of a session root is a lookup over the shared one.
    for (const guard of guards) expect(guard.keys instanceof Set).toBe(false);
    // A root that holds none of the places answers with the shared set itself.
    const outside = await privateGuardOf(REAL, root, `${await realpath(root)}/state/codex/agent-homes/F1`, LIST);
    const again = await privateGuardOf(REAL, root, `${await realpath(root)}/state/codex/agent-homes/F2`, LIST);
    expect(outside.keys).toBe(again.keys);
  });
});
