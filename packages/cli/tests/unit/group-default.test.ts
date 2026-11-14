/**
 * A group's default sub-verb (parity rows V-0161 / V-0321): v4 RAN `catalog ls` for a bare `fy catalog` and `member ls`
 * for a bare `fy member` (commander's `isDefault`), where 5.0 refused with "needs a sub-verb". A manifest `verb(...)` can
 * be declared its group's default; a bare group with one runs it with the flags passed through, a bare group without one
 * keeps the refusal, and an unknown sub-verb is still refused (exit 2) whatever stands before it.
 */
import { describe, it } from 'bun:test';
import { definePlugin, verb } from '@ferretry/kernel/manifest';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { fakeWorld, registryOf, skeletonEntry } from './fakes.ts';

const pantry = definePlugin({
  id: 'pantry',
  title: 'Pantry',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  actions: {
    cli: [
      verb('jar ls', { summary: 'every jar', args: [], default: true }),
      verb('jar add <name>', { summary: 'add a jar', args: [{ name: 'name', help: 'the jar' }] }),
      verb('bin put <thing>', { summary: 'put a thing', args: [{ name: 'thing', help: 'the thing' }] }),
      verb('bin take <thing>', { summary: 'take a thing', args: [{ name: 'thing', help: 'the thing' }] }),
      verb('shelf row ls', { summary: 'every row', args: [], default: true }),
      verb('shelf row add', { summary: 'add a row', args: [] }),
      verb('shelf pick', { summary: 'pick one', args: [] }),
    ],
  },
});
const table = () => buildVerbTable(registryOf(skeletonEntry(pantry)));

describe('a group with a declared default sub-verb', () => {
  it('should run the default for the bare group, with nothing left over', () => {
    const resolved = resolveVerb(table(), ['jar']);
    should(resolved.kind).equal('verb');
    if (resolved.kind !== 'verb') return;
    should(resolved.entry.line).equal('jar ls');
    should(resolved.rest).deepEqual([]);
  });

  it('should pass the flags typed after the bare group through to the default', () => {
    const resolved = resolveVerb(table(), ['jar', '--json', '--all']);
    should(resolved.kind).equal('verb');
    if (resolved.kind !== 'verb') return;
    should(resolved.entry.line).equal('jar ls');
    should(resolved.rest).deepEqual(['--json', '--all']);
  });

  it('should still run a named sub-verb, not the default', () => {
    const resolved = resolveVerb(table(), ['jar', 'add', 'honey']);
    should(resolved.kind === 'verb' && resolved.entry.line).equal('jar add <name>');
  });

  it('should still refuse an unknown sub-verb, bare or after a switch', () => {
    const bare = resolveVerb(table(), ['jar', 'frobnicate']);
    should(bare.kind).equal('subverb');
    if (bare.kind === 'subverb') should(bare.word).equal('frobnicate');
    const after = resolveVerb(table(), ['jar', '--json', 'frobnicate']);
    should(after.kind).equal('subverb');
    if (after.kind === 'subverb') should(after.word).equal('frobnicate');
  });

  it('should run a default at any depth of the group', () => {
    const resolved = resolveVerb(table(), ['shelf', 'row', '--json']);
    should(resolved.kind === 'verb' && resolved.entry.line).equal('shelf row ls');
    // `shelf` itself has no default: the sub-group is not one.
    should(resolveVerb(table(), ['shelf']).kind).not.equal('verb');
  });
});

describe('a bare group without a declared default', () => {
  it('should keep the refusal, with or without flags', () => {
    should(resolveVerb(table(), ['bin']).kind).not.equal('verb');
    should(resolveVerb(table(), ['bin', '--json']).kind).not.equal('verb');
    should(resolveVerb(table(), ['bin', '--json', 'frobnicate']).kind).not.equal('verb');
  });
});

describe('through the shell', () => {
  it('should exit 2 for a bare group without a default and 0 for one with, `--help` still printing the group', async () => {
    const run = async (...argv: string[]) => {
      const { world, io } = fakeWorld({ registry: registryOf(skeletonEntry(pantry)) });
      const code = await runFy(argv, world);
      return { code, out: io.stdout(), err: io.stderr() };
    };
    should((await run('bin')).code).equal(2);
    const help = await run('jar', '--help');
    should(help.code).equal(0);
    // The group's help lists its verbs; it is not the default verb's own help.
    should(help.out).containEql('add <name>');
    should(help.out).containEql('ls');
    should(help.out.startsWith('Usage: fy jar <verb>')).equal(true);
    const unknown = await run('jar', '--json', 'frobnicate');
    should(unknown.code).equal(2);
    should(unknown.err).containEql('"frobnicate" is not a sub-verb of jar');
  });
});

/** The groups v4 ran a default for that 5.0 has as a group, and the default each declares (the rest: see the unit's report). */
const DECLARED: Readonly<Record<string, string>> = {
  catalog: 'catalog ls',
  member: 'member ls',
  device: 'device ls',
  account: 'account ls',
  'account site': 'account site ls',
  'account site recipe': 'account site recipe show',
  'account factor': 'account factor ls',
};

describe('the real registry', () => {
  const real = buildVerbTable(registry);

  it('should declare exactly the v4 defaults 5.0 has a group for', () => {
    const declared = real.entries.filter(entry => entry.default === true);
    const found: Record<string, string> = {};
    for (const entry of declared) found[entry.words.slice(0, -1).join(' ')] = entry.words.join(' ');
    should(found).deepEqual(DECLARED);
  });

  it('should declare at most one default per group, and only a direct child of it', () => {
    const groups = real.entries
      .filter(entry => entry.default === true)
      .map(entry => entry.words.slice(0, -1).join(' '));
    should(new Set(groups).size).equal(groups.length);
  });

  // One literal title per ledger row, so the parity ledger can name the test that proves it.
  const bare = (group: string, line: string): void => {
    const resolved = resolveVerb(real, group.split(' '));
    should(resolved.kind === 'verb' && resolved.entry.words.join(' ')).equal(line);
  };
  it('V-0252 a bare `fy device` lists the paired devices, as v4 did', () => bare('device', 'device ls'));
  it('V-0002 a bare `fy account` lists the accounts', () => bare('account', 'account ls'));
  it('V-0019 a bare `fy account site` lists the sign-ins', () => bare('account site', 'account site ls'));
  it('V-0023 a bare `fy account site recipe` shows a sign-in’s recipe', () =>
    bare('account site recipe', 'account site recipe show'));
  it('V-0009 a bare `fy account factor` lists the 2FA keys', () => bare('account factor', 'account factor ls'));
  it('V-0161 a bare `fy catalog` lists the catalogs', () => bare('catalog', 'catalog ls'));
  it('V-0321 a bare `fy member` lists the members', () => bare('member', 'member ls'));

  for (const [group, line] of Object.entries(DECLARED))
    it(`should run \`${line}\` for a bare \`${group}\`, flags kept`, () => {
      const resolved = resolveVerb(real, [...group.split(' '), '--json']);
      should(resolved.kind === 'verb' && resolved.entry.words.join(' ')).equal(line);
      should(resolved.kind === 'verb' && resolved.rest).deepEqual(['--json']);
      const refused = resolveVerb(real, [...group.split(' '), '--json', 'frobnicate']);
      should(refused.kind).equal('subverb');
    });
});
