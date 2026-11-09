/**
 * Which harness homes a published manifest names, as the reader may serve them: a fleet home by its folder name, a home an
 * operator placed elsewhere under its account's id, and nothing that is not a plain absolute folder or that sits inside the
 * Ferretry home. Pure: a manifest and the fleet folder's path in, the homes out.
 */
import { describe, expect, it } from 'bun:test';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import { homesOf } from '../../../daemon/lib/service/runtime-homes.ts';

const FLEET = '/placeholder/fy-home/fleet';

type Account = FleetManifest['accounts'][number];
type Runtime = FleetManifest['runtimes'][number];

const account = (id: number, home: string, wrapper: string, kind: Account['kind'] = 'claude'): Account => ({
  secretEnv: {},
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  kind,
  mode: 'auto',
  wrapper,
  home,
  displayName: 'Placeholder',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  available: true,
  unavailableReason: null,
});

const runtime = (id: number, name: string, wrapper: string): Runtime => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  name,
  harness: 'claude',
  credential: 'one',
  profile: 'default',
  agent: true,
  wrapper,
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  defaultModel: 'model-one',
});

const manifest = (accounts: readonly Account[], runtimes: readonly Runtime[] = []): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts,
  runtimes,
});

describe('the harness homes a manifest names', () => {
  it('lists none for a machine no apply has published to', () => {
    expect(homesOf(undefined, FLEET)).toEqual([]);
  });

  it('names a fleet home by its folder, with the runtimes that run in it, in manifest order and without repeats', () => {
    const homes = homesOf(
      manifest(
        [account(1, `${FLEET}/homes/one`, '/placeholder/bin/work')],
        [runtime(1, 'work', '/placeholder/bin/work'), runtime(1, 'work-two', '/placeholder/bin/work-two')],
      ),
      FLEET,
    );

    expect(homes.map(home => ({ ...home, runtimes: home.runtimes.map(String) }))).toEqual([
      {
        id: 'one',
        harness: 'claude-code',
        runtimes: ['work', 'work-two'],
        home: `${FLEET}/homes/one`,
        wrapper: '/placeholder/bin/work',
      },
    ]);
  });

  it('lists a home an operator placed elsewhere under its account’s id, read through its own folder', () => {
    const external = account(2, '/placeholder/people/me/.claude-work', '/placeholder/bin/elsewhere', 'codex');

    const [home] = homesOf(manifest([external]), FLEET);

    expect(home).toMatchObject({ id: external.id, harness: 'codex', home: '/placeholder/people/me/.claude-work' });
  });

  it('lists no home that is not a plain absolute folder', () => {
    const homes = homesOf(
      manifest([
        account(1, 'relative/home', '/placeholder/bin/a'),
        account(2, '/placeholder/people/../me', '/placeholder/bin/b'),
        account(3, '/placeholder/people/me/', '/placeholder/bin/c'),
        account(4, '/placeholder/people\\me', '/placeholder/bin/d'),
        account(5, '/placeholder/./me', '/placeholder/bin/e'),
      ]),
      FLEET,
    );

    expect(homes).toEqual([]);
  });

  it('lists no home inside the Ferretry home unless it is a fleet home, or whose folder name is not a plain name', () => {
    const homes = homesOf(
      manifest([
        account(1, '/placeholder/fy-home', '/placeholder/bin/a'),
        account(2, '/placeholder/fy-home/state/somewhere', '/placeholder/bin/b'),
        account(3, `${FLEET}/homes/.hidden`, '/placeholder/bin/c'),
        account(4, `${FLEET}/homes/one/deeper`, '/placeholder/bin/d'),
      ]),
      FLEET,
    );

    expect(homes).toEqual([]);
  });

  it('gives an id two different folders claim to the first, and serves one folder once for the accounts in it', () => {
    const first = account(1, '/placeholder/people/a/.claude', '/placeholder/bin/a');
    const clashing = { ...account(3, '/placeholder/people/b/.claude', '/placeholder/bin/c'), id: first.id };
    const shared = account(4, `${FLEET}/homes/shared`, '/placeholder/bin/d');
    const sameFolder = account(5, `${FLEET}/homes/shared`, '/placeholder/bin/e');

    const homes = homesOf(manifest([first, clashing, shared, sameFolder]), FLEET);

    expect(homes).toHaveLength(2);
    expect(homes[0]).toMatchObject({ id: first.id, home: '/placeholder/people/a/.claude', runtimes: ['a'] });
    expect(homes[1]).toMatchObject({ id: 'shared', home: `${FLEET}/homes/shared`, runtimes: ['d', 'e'] });
  });

  it('leaves out a wrapper name that is not a runtime name', () => {
    const [home] = homesOf(manifest([account(1, `${FLEET}/homes/one`, '/placeholder/bin/under_score')]), FLEET);

    expect(home?.runtimes).toEqual([]);
  });
});
