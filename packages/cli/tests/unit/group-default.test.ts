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
      verb('crate ls', {
        summary: 'every crate, or one',
        args: [{ name: 'name', help: 'the crate', optional: true }],
        default: true,
      }),
      verb('crate remove', { summary: 'remove a crate', args: [{ name: 'name', help: 'the crate' }] }),
      verb('crate stack', { summary: 'stack the crates', args: [] }),
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

describe('a group whose default takes words of its own (v4: fy account site GITHUB)', () => {
  const resolvedLine = (...words: string[]) => {
    const resolved = resolveVerb(table(), words);
    return resolved.kind === 'verb' ? { line: resolved.entry.line, rest: resolved.rest } : resolved.kind;
  };

  it('should hand a word that names no sub-verb to the default, the word and the flags kept', () => {
    should(resolvedLine('crate', 'apples')).deepEqual({ line: 'crate ls', rest: ['apples'] });
    should(resolvedLine('crate', '--json', 'apples')).deepEqual({ line: 'crate ls', rest: ['--json', 'apples'] });
    should(resolvedLine('crate', 'apples', '--json')).deepEqual({ line: 'crate ls', rest: ['apples', '--json'] });
    should(resolvedLine('crate', '--json')).deepEqual({ line: 'crate ls', rest: ['--json'] });
  });

  it('should give a typed sub-verb priority over the default, so a mutating child runs only when typed', () => {
    should(resolvedLine('crate', 'remove', 'apples')).deepEqual({ line: 'crate remove', rest: ['apples'] });
    should(resolvedLine('crate', '--json', 'remove', 'apples')).deepEqual({
      line: 'crate remove',
      rest: ['--json', 'apples'],
    });
  });

  it('should refuse a near misspelling of a real sub-verb instead of running the default on it', () => {
    const typo = resolveVerb(table(), ['crate', 'remvoe', 'apples']);
    should(typo.kind).equal('subverb');
    if (typo.kind !== 'subverb') return;
    should(typo.word).equal('remvoe');
    should(typo.didYouMean?.words).deepEqual(['crate', 'remove']);
  });

  it('should take every word past -- as the default’s own, a misspelling included', () => {
    should(resolvedLine('crate', '--', 'remvoe')).deepEqual({ line: 'crate ls', rest: ['--', 'remvoe'] });
  });

  it('should keep refusing an unknown sub-verb of a default that takes no words', () => {
    should(resolveVerb(table(), ['jar', 'frobnicate']).kind).equal('subverb');
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
  config: 'config check',
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
  it('V-0189 a bare `fy config` checks the configuration files, as v4 did', () => bare('config', 'config check'));
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
      const own = real.entries.find(entry => entry.words.join(' ') === line);
      const taking = (own?.args?.length ?? 0) > 0;
      const after = resolveVerb(real, [...group.split(' '), '--json', 'frobnicate']);
      // A default that takes words of its own is handed the word; one that takes none refuses it.
      if (taking) should(after.kind === 'verb' && after.entry.words.join(' ')).equal(line);
      else should(after.kind).equal('subverb');
    });

  // The three account forms v4 ran with their argument (account-commands.ts:207, 246, 288; its test :446).
  const forms = (...words: string[]) => {
    const resolved = resolveVerb(real, words);
    return resolved.kind === 'verb' ? { line: resolved.entry.words.join(' '), rest: resolved.rest } : resolved.kind;
  };
  it('V-0019 `fy account site GITHUB` runs `account site ls GITHUB`', () => {
    should(forms('account', 'site', 'GITHUB')).deepEqual({ line: 'account site ls', rest: ['GITHUB'] });
    should(forms('account', 'site', 'GITHUB', '--json')).deepEqual({
      line: 'account site ls',
      rest: ['GITHUB', '--json'],
    });
    // A named child is still the child; a misspelling of one is still refused.
    should(forms('account', 'site', 'rm', 'si_0123456789abcdef')).deepEqual({
      line: 'account site rm',
      rest: ['si_0123456789abcdef'],
    });
    should(forms('account', 'site', 'recpie', 'si_0123456789abcdef')).equal('subverb');
  });
  it('V-0009 `fy account factor GITHUB` runs `account factor ls GITHUB`', () => {
    should(forms('account', 'factor', 'GITHUB')).deepEqual({ line: 'account factor ls', rest: ['GITHUB'] });
    should(forms('account', 'factor', '--json', 'GITHUB')).deepEqual({
      line: 'account factor ls',
      rest: ['--json', 'GITHUB'],
    });
    should(forms('account', 'factor', 'add', 'GITHUB')).deepEqual({ line: 'account factor add', rest: ['GITHUB'] });
    should(forms('account', 'factor', 'ad', 'GITHUB')).deepEqual({ line: 'account factor ls', rest: ['ad', 'GITHUB'] });
  });
  it('V-0023 `fy account site recipe si_…` runs `account site recipe show si_…`', () => {
    should(forms('account', 'site', 'recipe', 'si_0123456789abcdef')).deepEqual({
      line: 'account site recipe show',
      rest: ['si_0123456789abcdef'],
    });
    should(forms('account', 'site', 'recipe', 'clear', 'si_0123456789abcdef')).deepEqual({
      line: 'account site recipe clear',
      rest: ['si_0123456789abcdef'],
    });
    should(forms('account', 'site', 'recipe', 'aprove', 'si_0123456789abcdef')).equal('subverb');
  });
  it('should keep refusing an unknown sub-verb of the account groups whose default takes none', () => {
    should(forms('account', 'frobnicate')).equal('subverb');
    should(forms('account', 'default', 'frobnicate')).equal('subverb');
  });
});
