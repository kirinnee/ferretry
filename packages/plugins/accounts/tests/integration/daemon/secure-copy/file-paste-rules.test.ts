import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PasteRule } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FilePasteRuleStore } from '../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/** The owner's pre-approval rules over a REAL state home: routes and counts only, in a private folder. */

const OFF = { allowProfileTargets: false };
const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  remaining: 1,
  used: 0,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-copy-rules-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const directory = join(paths.state, 'secure-copy');
  return { directory, store: new FilePasteRuleStore(directory, new StateFileSystem(paths)) };
}

describe('FilePasteRuleStore over a real state home', () => {
  it('should read nothing before the first write, then the rules it wrote, from a private folder', async () => {
    const { directory, store } = await fixture();

    should(await store.read()).be.undefined();
    await store.write({ rules: [RULE], settings: OFF });

    should(await store.read()).eql({ rules: [RULE], settings: OFF });
    should(JSON.parse(await readFile(join(directory, 'rules.json'), 'utf8'))).eql({
      v: 1,
      rules: [RULE],
      settings: OFF,
    });
    should((await stat(directory)).mode & 0o777).equal(0o700);
  });

  it('should throw on a damaged file rather than read it as no rules', async () => {
    const { directory, store } = await fixture();
    await store.write({ rules: [], settings: OFF });
    await writeFile(join(directory, 'rules.json'), '{"v":1,"rules":[{"id":"x"}]}');

    should(
      await store.read().then(
        () => 'read',
        () => 'threw',
      ),
    ).equal('threw');
  });
});
