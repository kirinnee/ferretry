import { describe, it } from 'bun:test';
import { join } from 'node:path';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { homeText } from '../../../daemon/lib/harness/launch.ts';
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

  it('prints, after a compaction, the assignment, the agenda and the owed messages with the 5.0 verbs and this ferret’s id, and no verb the work switch turns off', async () => {
    const { code, out, err } = await run(CLAUDE_REABSORB_COMMAND, { FY_SESSION_ID: 'sess-42', FY_TOKEN: SECRET });
    should(code).equal(0);
    should(err).equal('');
    for (const needle of [
      'You were just compacted',
      'session sess-42',
      'fy logs sess-42 --turn 1',
      'Your assignment',
      'fy agenda ls',
      'fy agenda show <id>',
      'owe a reply',
      'fy transcript sess-42 --tail',
      'fy reply <id> <text>',
    ])
      should(out).containEql(needle);
    // The work switch (Board, Agenda, Loops) can be off: this text names none of its verbs. Board's own instruction
    // (given only while Board is on) tells a ferret to re-read its task after a compaction.
    should(out).not.match(/\bfy (?:task|board)\b/u);
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
    should(found).eql(['agenda ls', 'agenda show', 'logs', 'reply', 'transcript']);
    should(namedVerbs(['run fy task zap now'], declared).unknown).eql(['task zap now']);
    should(namedVerbs(CLAUDE_KEEP_LINES, declared).found).eql([]);
  });

  it('prints before a compaction what the summary must keep, and nothing secret', async () => {
    const { code, out, err } = await run(CLAUDE_KEEP_COMMAND, { FY_SESSION_ID: 'sess-42', FY_TOKEN: SECRET });
    should(code).equal(0);
    should(err).equal('');
    for (const needle of ['your assignment', 'agenda item ids', 'owe a reply', 'PR links'])
      should(out).containEql(needle);
    should(out).not.containEql('task');
    should(out).not.containEql('card');
    should(out).not.containEql(SECRET);
  });
});

/** The two Claude payloads as they were before the work switch moved Board's lines out (the base wording, Board on). */
const BASE_REABSORB = [
  'You were just compacted, so part of your earlier context is gone. This is session sess-42.',
  'Before you continue, take back in everything you still owe:',
  '1. Your assignment: read your first turn again with `fy logs sess-42 --turn 1`; it names the turn file to read and follow.',
  '2. Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  '3. Your open agenda items: `fy agenda ls`, then `fy agenda show <id>` for each.',
  '4. Messages you still owe a reply to: `fy transcript sess-42 --tail`, then answer with `fy reply <id> <text>`.',
  'Then carry on with your next step. Do not ask the owner for what your assignment or agenda already says.',
].join('\n');

const BASE_KEEP =
  'When you summarise this conversation, keep: your assignment and how far you are; your task id and its status (now, done so far, next); your open agenda item ids; every message you still owe a reply to and who sent it; and the branch and PR links you own. After the compaction you will be told to read the assignment, the task, the agenda and the owed messages again, so the summary must name where each one is.';

/** What Board hands a launch while it is on, in the words Board owns (its own test pins the same words). */
const BOARD_ADDS = {
  kind: 'compaction',
  reabsorb:
    'Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  keep: 'your task id and its status (now, done so far, next)',
  reread: 'the task',
} as const;

const squash = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

describe('the compaction hooks a launch writes, with the work switch on and off', () => {
  const overlayHooks = (parts: readonly LaunchPart[]) =>
    JSON.parse(
      homeText({
        folder: '/work',
        permissionMode: 'auto',
        instructions: [],
        parts,
        settings: new Map(),
        hooks: new Map(),
      }).overlay,
    ).hooks as {
      SessionStart: { hooks: { command: string }[] }[];
      PreCompact: { hooks: { command: string }[] }[];
    };

  it('with Board on (its compaction part), the ACTUAL payloads carry the task lines: the base wording', async () => {
    const hooks = overlayHooks([BOARD_ADDS]);
    const reabsorb = await run(hooks.SessionStart[0]?.hooks[0]?.command ?? '', { FY_SESSION_ID: 'sess-42' });
    const keep = await run(hooks.PreCompact[0]?.hooks[0]?.command ?? '', { FY_SESSION_ID: 'sess-42' });
    should(squash(reabsorb.out)).equal(squash(BASE_REABSORB));
    should(squash(keep.out)).equal(squash(BASE_KEEP));
    should(reabsorb.out).containEql('fy task show <task id>');
    should(reabsorb.out).containEql('fy board status');
    should(keep.out).containEql('your task id and its status');
  });

  it('with Board off (no part), the payloads are core’s alone and name no task or board verb', async () => {
    const hooks = overlayHooks([]);
    should(hooks).eql(JSON.parse(JSON.stringify({ ...CLAUDE_COMPACTION_HOOKS })));
    const reabsorb = await run(hooks.SessionStart[0]?.hooks[0]?.command ?? '', { FY_SESSION_ID: 'sess-42' });
    const keep = await run(hooks.PreCompact[0]?.hooks[0]?.command ?? '', {});
    should(reabsorb.out).not.match(/\bfy (?:task|board)\b/u);
    should(reabsorb.out).containEql('3. Messages you still owe');
    should(keep.out).not.containEql('task');
  });
});
