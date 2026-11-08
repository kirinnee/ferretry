/** K3: `kernel.hostFacts.launchGuard()` — decided once by the kernel, handed to a plugin that declared hostFacts. */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { launchGuardActive, launchGuardFor } from '../../../host/adapters/launch-guard.ts';
import { nodeHostFacts, undeclaredHostFacts } from '../../../host/adapters/host-facts.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const noLinks = (path: string): string => path;
const roots = ['/tmp', '/var/folders', '/private/tmp'];

describe('K3 launchGuardFor decides active once, from FERRETRY_TEST and the home', () => {
  test('K3 FERRETRY_TEST=1 arms it whatever the home', () => {
    const guard = launchGuardFor({
      home: '/home/person/.ferretry',
      environment: { FERRETRY_TEST: '1', PATH: '/bin' },
      canonical: noLinks,
      temporaryRoots: roots,
    });
    expect(guard()).toEqual({ active: true, searchPath: '/bin' });
  });

  for (const flag of [undefined, '', '0', 'true', 'yes'])
    test(`K3 FERRETRY_TEST=${JSON.stringify(flag)} on a person's home leaves it off`, () => {
      const guard = launchGuardFor({
        home: '/home/person/.ferretry',
        environment: flag === undefined ? { PATH: '/bin' } : { FERRETRY_TEST: flag, PATH: '/bin' },
        canonical: noLinks,
        temporaryRoots: roots,
      });
      expect(guard()).toEqual({ active: false, searchPath: '/bin' });
    });

  for (const home of ['/tmp/fy-home-1', '/tmp', '/var/folders/ab/cd/T/fy', '/private/tmp/x'])
    test(`K3 a home under a temporary folder (${home}) arms it with no flag`, () => {
      const guard = launchGuardFor({ home, environment: {}, canonical: noLinks, temporaryRoots: roots });
      expect(guard()).toEqual({ active: true });
    });

  for (const home of ['/tmpfoo/x', '/var/foldersish/x', '/home/tmp/x', '/tmp2'])
    test(`K3 ${home} is not under a temporary folder: a sibling name is not a prefix match`, () => {
      expect(launchGuardActive({ flag: undefined, home, temporaryRoots: roots })).toBe(false);
    });

  test("K3 the home's real path is what is judged: a link in a person's home to /tmp arms it", () => {
    const guard = launchGuardFor({
      home: '/home/person/link',
      environment: {},
      canonical: path => (path === '/home/person/link' ? '/tmp/real-home' : path),
      temporaryRoots: roots,
    });
    expect(guard().active).toBe(true);
  });

  test('K3 the temporary folders are resolved too, and an empty one never matches', () => {
    const guard = launchGuardFor({
      home: '/private/tmp/fy',
      environment: {},
      canonical: path => (path === '/tmp' ? '/private/tmp' : path),
      temporaryRoots: ['/tmp', ''],
    });
    expect(guard().active).toBe(true);
    expect(launchGuardActive({ flag: undefined, home: '/anything', temporaryRoots: [''] })).toBe(false);
  });

  test('K3 active is decided once at boot; the PATH is the daemon’s as it stands when asked', () => {
    const environment: Record<string, string | undefined> = { PATH: '/one' };
    const guard = launchGuardFor({ home: '/home/p/.fy', environment, canonical: noLinks, temporaryRoots: roots });
    expect(guard()).toEqual({ active: false, searchPath: '/one' });
    environment['FERRETRY_TEST'] = '1';
    environment['PATH'] = '/two';
    expect(guard()).toEqual({ active: false, searchPath: '/two' });
    delete environment['PATH'];
    expect(guard()).toEqual({ active: false });
  });

  test('K3 the fact is frozen so a plugin cannot arm or disarm it for the next reader', () => {
    const guard = launchGuardFor({ home: '/tmp/x', environment: { PATH: '/bin' }, canonical: noLinks });
    const fact = guard();
    expect(Object.isFrozen(fact)).toBe(true);
    expect(() => {
      (fact as { active: boolean }).active = false;
    }).toThrow();
    expect(guard().active).toBe(true);
  });

  test('K3 a missing path is judged as named (realpath failing falls back to the path)', () => {
    const guard = launchGuardFor({ home: '/tmp/definitely-not-there-k3/fy', environment: {} });
    expect(guard().active).toBe(true);
  });
});

describe('K3 hostFacts.launchGuard is gated like the other hostFacts', () => {
  const base = nodeHostFacts({ proc: '/nonexistent-proc', sys: '/nonexistent-sys' });

  test('K3 a node host with nothing decided fails closed: active, no search path', () => {
    expect(base.launchGuard()).toEqual({ active: true });
  });

  test('K3 nodeHostFacts hands what the kernel decided', () => {
    const facts = nodeHostFacts({
      launchGuard: launchGuardFor({ home: '/tmp/x', environment: { PATH: '/bin:/usr/bin' }, canonical: noLinks }),
    });
    expect(facts.launchGuard()).toEqual({ active: true, searchPath: '/bin:/usr/bin' });
  });

  test('K3 a plugin without permissions.hostFacts is refused; one with it gets the fact', async () => {
    const facts = nodeHostFacts({
      launchGuard: launchGuardFor({ home: '/tmp/x', environment: { PATH: '/p' }, canonical: noLinks }),
    });
    const seen: Record<string, () => unknown> = {};
    const half = (id: string, hostFacts?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(hostFacts === undefined ? {} : { permissions: { hostFacts } }),
        }),
        {
          build: ctx => {
            seen[id] = () => ctx.kernel.hostFacts.launchGuard();
            return {};
          },
        },
      );
    const host = await testHost({ plugins: [half('terminals', true), half('other')], hostFacts: facts });
    expect(seen['terminals']?.()).toEqual({ active: true, searchPath: '/p' });
    expect(() => seen['other']?.()).toThrow('did not declare permissions.hostFacts');
    await host.stop();
  });

  test('K3 the undeclared wrapper refuses the guard fact and still names the plain ones', () => {
    const refused = undeclaredHostFacts('x', base);
    expect(() => refused.launchGuard()).toThrow('x did not declare permissions.hostFacts');
    expect(refused.platform).toBe(base.platform);
  });
});

describe('K3 no environment read outside the kernel adapter', () => {
  test('K3 no plugin source reads FERRETRY_TEST (Terminals names it only until U1 deletes its copy)', async () => {
    const root = new URL('../../../../../', import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const file of new Glob('plugins/*/{daemon,lib}/**/*.ts').scan({ cwd: root })) {
      if (file.includes('/tests/')) continue;
      const text = await Bun.file(`${root}${file}`).text();
      // the terminals guard module names the variable as a constant until U1 deletes it; no other plugin may
      if (/FERRETRY_TEST/u.test(text) && !file.startsWith('plugins/terminals/')) offenders.push(file);
    }
    for await (const file of new Glob('ferrets/{daemon,lib}/**/*.ts').scan({ cwd: `${root}core/` })) {
      const text = await Bun.file(`${root}core/${file}`).text();
      if (/FERRETRY_TEST/u.test(text)) offenders.push(`core/${file}`);
    }
    expect(offenders).toEqual([]);
  });

  test('K3 within the kernel, FERRETRY_TEST is named by the launch-guard adapter alone', async () => {
    const kernel = new URL('../../../', import.meta.url).pathname;
    const named: string[] = [];
    for await (const file of new Glob('{host,manifest,testing}/**/*.ts').scan({ cwd: kernel })) {
      const text = await Bun.file(`${kernel}${file}`).text();
      if (/FERRETRY_TEST/u.test(text)) named.push(file);
    }
    expect(named).toEqual(['host/adapters/launch-guard.ts']);
  });
});
