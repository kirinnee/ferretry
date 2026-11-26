import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { fakeWorld } from './fakes.ts';

/**
 * A verb 5.0 renamed says where it went (C-21, C-22, C-25, C-26, D-45) instead of a bare "unknown verb"; and the other
 * spelling of a list verb (`project ls`, `profile list`) runs as the real one with no note (D-46). The REAL registry, so
 * a pointer to a verb that was renamed again fails here.
 */

const run = async (words: readonly string[]) => {
  const { world, io } = fakeWorld({ registry });
  const code = await runFy(words, world);
  return { code, err: io.stderr(), out: io.stdout() };
};

const table = buildVerbTable(registry);
const declared = (line: string): boolean =>
  table.entries.some(entry => entry.line === line && entry.alias === undefined);

describe('a renamed verb points at its replacement', () => {
  for (const [typed, now] of [
    [['migrate', 'wren'], 'ferret move <id>'],
    [['harness', 'status'], 'harness <claude-code|codex> status'],
    [['harness', 'update'], 'harness <claude-code|codex> update'],
    [['session', 'compact-at', 'wren', '250k'], 'compact-at <ferret> [value]'],
    [['import', 'conversations'], 'link'],
    [['credentials'], 'login ls'],
    [['logins'], 'login ls'],
    [['credential', 'add'], 'login'],
    [['fleet', 'recommend'], 'recommend'],
  ] as const) {
    const old =
      typed[0] === 'session' || typed[0] === 'harness' || typed[0] === 'import' ? typed.slice(0, 2) : typed.slice(0, 1);
    it(`should say \`fy ${old.join(' ')}\` is now \`fy ${now}\`, exit 2, and run nothing`, async () => {
      const { code, err, out } = await run(typed);
      should(code).equal(2);
      should(err).equal(`fy: \`fy ${old.join(' ')}\` is now \`fy ${now}\`\n`);
      should(out).equal('');
    });
  }

  it('should point only at verbs 5.0 really has', () => {
    for (const line of ['ferret move <id>', 'compact-at', 'link [query...]', 'login ls', 'recommend'])
      should(table.entries.some(entry => entry.line.startsWith(line.split(' <')[0] as string))).be.true();
    should(table.entries.some(entry => entry.words.join(' ') === 'harness codex status')).be.true();
  });

  it('should leave a word nothing renamed as the ordinary unknown verb', async () => {
    const { code, err } = await run(['frobnicate']);
    should(code).equal(2);
    should(err).match(/^fy: unknown verb "frobnicate"/u);
  });
});

describe('a list verb takes both spellings (D-46)', () => {
  it('should run `project ls` as `project list` and `profile list` as `profile ls`, silently, and list neither in help', async () => {
    should(declared('project list')).be.true();
    should(declared('profile ls')).be.true();
    for (const [alias, target] of [
      [['project', 'ls'], 'project list'],
      [['profile', 'list'], 'profile ls'],
    ] as const) {
      const resolved = resolveVerb(table, alias);
      should(resolved.kind).equal('verb');
      if (resolved.kind !== 'verb') continue;
      should(resolved.entry.alias).equal(target);
      should(resolved.entry.hidden).be.true();
      should(resolved.entry.quiet).be.true();
    }
    const help = await run(['--help']);
    should(help.out).not.match(/project ls\b/u);
    should(help.out).not.match(/profile list\b/u);
  });

  it('should say nothing on stderr when the alias runs', async () => {
    const { err } = await run(['project', 'ls']);
    should(err).not.containEql('is now');
  });
});
