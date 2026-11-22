import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import {
  CLAUDE_COMPACT_MATCHER,
  CLAUDE_COMPACTION_HOOKS,
  CLAUDE_KEEP_COMMAND,
  CLAUDE_KEEP_LINES,
  CLAUDE_REABSORB_COMMAND,
  CLAUDE_REABSORB_LINES,
} from '../../../daemon/lib/harness/compaction.ts';
import { fixedLayer } from '../../../daemon/lib/harness/fixed-layer.ts';

/** Runs a hook command the way Claude does (`sh -c`), with only the environment given: a secret is planted to prove it never prints. */
async function run(command: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(['sh', '-c', command], {
    env: { PATH: '/usr/bin:/bin', ...env },
    stdin: Buffer.from(''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  return { code, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
}

const SECRET = 'sk-ant-secret-value-1234';

/** Every `verb('<line>')` a manifest declares, as the words before its first argument: `agenda show <id>` is `agenda show`. */
async function declaredVerbs(): Promise<Set<string>> {
  const verbs = new Set<string>();
  // Core Asks owns the item verbs (`agenda add`, `agenda show`…) and `notify`; the plugins keep the rest.
  const roots = [
    join(import.meta.dir, '../../../../../core/asks'),
    ...['board', 'agenda', 'conversation'].map(plugin => join(import.meta.dir, '../../../..', plugin)),
  ];
  for (const root of roots) {
    // The manifest shell and every feature fragment under manifest/actions/ (a plugin may keep its verbs in either).
    const files = ['manifest.ts', ...(await Array.fromAsync(new Bun.Glob('manifest/actions/*.actions.ts').scan(root)))];
    const source = (await Promise.all(files.map(file => Bun.file(join(root, file)).text()))).join('\n');
    for (const [, line] of source.matchAll(/verb\('([^']+)'/gu))
      verbs.add(
        (line ?? '')
          .split(' ')
          .filter((_, at, all) => !all.slice(0, at + 1).some(w => /^[<[]/u.test(w)))
          .join(' '),
      );
  }
  return verbs;
}

/** The verbs a text tells the ferret to run: the longest declared verb after each `fy`. */
function namedVerbs(lines: readonly string[], declared: ReadonlySet<string>): { found: string[]; unknown: string[] } {
  const found: string[] = [];
  const unknown: string[] = [];
  for (const [, run] of lines.join('\n').matchAll(/\bfy ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/gu)) {
    const words = (run ?? '').split(' ');
    const verb = words
      .map((_, at) => words.slice(0, words.length - at).join(' '))
      .find(candidate => declared.has(candidate));
    if (verb === undefined) unknown.push(run ?? '');
    else found.push(verb);
  }
  return { found: found.toSorted(), unknown };
}

describe('the compaction hooks in the fixed layer', () => {
  it('puts SessionStart (matcher compact) and PreCompact into the overlay, and into the fingerprinted settings nowhere else', () => {
    for (const mode of ['auto', 'skip'] as const) {
      const layer = fixedLayer(mode, '/work');
      should(layer.overlay.hooks.SessionStart).eql([
        { matcher: 'compact', hooks: [{ type: 'command', command: CLAUDE_REABSORB_COMMAND }] },
      ]);
      should(layer.overlay.hooks.PreCompact).eql([{ hooks: [{ type: 'command', command: CLAUDE_KEEP_COMMAND }] }]);
      // M7: the question hook is gone, so these two are the whole of it.
      should(Object.keys(layer.overlay.hooks).toSorted()).eql(['PreCompact', 'SessionStart']);
      should('hooks' in layer.settings).equal(false);
    }
    should(CLAUDE_COMPACT_MATCHER).equal('compact');
    should(CLAUDE_COMPACTION_HOOKS.SessionStart).have.length(1);
  });

  it('prints, after a compaction, the task, the board task, the agenda and the owed messages with the 5.0 verbs and this ferret’s id', async () => {
    const { code, out, err } = await run(CLAUDE_REABSORB_COMMAND, { FY_SESSION_ID: 'sess-42', FY_TOKEN: SECRET });
    should(code).equal(0);
    should(err).equal('');
    for (const needle of [
      'You were just compacted',
      'session sess-42',
      'fy logs sess-42 --turn 1',
      'Your assignment',
      'fy task show <task id>',
      'fy board status',
      'fy agenda ls',
      'fy agenda show <id>',
      'owe a reply',
      'fy transcript sess-42 --tail',
      'fy reply <id> <text>',
    ])
      should(out).containEql(needle);
    should(out).not.containEql('%s');
    should(out).not.containEql(SECRET);
  });

  it('still prints, with a plain stand-in, in a pane that has no session id', async () => {
    const { code, out } = await run(CLAUDE_REABSORB_COMMAND, {});
    should(code).equal(0);
    should(out).containEql('fy logs <your session id> --turn 1');
  });

  it('names only verbs the 5.0 manifests declare, and exactly the ones it should', async () => {
    const declared = await declaredVerbs();
    for (const real of ['task show', 'board status', 'agenda ls', 'agenda show', 'logs', 'transcript', 'reply'])
      should(declared.has(real)).equal(true);
    should(declared.has('task zap')).equal(false);
    const { found, unknown } = namedVerbs(CLAUDE_REABSORB_LINES, declared);
    should(unknown).eql([]);
    should(found).eql(['agenda ls', 'agenda show', 'board status', 'logs', 'reply', 'task show', 'transcript']);
    should(namedVerbs(['run fy task zap now'], declared).unknown).eql(['task zap now']);
    should(namedVerbs(CLAUDE_KEEP_LINES, declared).found).eql([]);
  });

  it('prints before a compaction what the summary must keep, and nothing secret', async () => {
    const { code, out, err } = await run(CLAUDE_KEEP_COMMAND, { FY_SESSION_ID: 'sess-42', FY_TOKEN: SECRET });
    should(code).equal(0);
    should(err).equal('');
    for (const needle of ['your assignment', 'your task id', 'agenda item ids', 'owe a reply', 'PR links'])
      should(out).containEql(needle);
    should(out).not.containEql('card');
    should(out).not.containEql(SECRET);
  });
});
