/**
 * EACH FERRET'S OWN CONVERSATION, carried into the agent home v5 proves and resumes it from.
 *
 * v4 kept every transcript in a runtime's home (really the shared pool behind it) and named it in the session's
 * `config.json`. v5 gives each ferret its OWN agent home and proves its transcript only from inside it:
 *
 *  - Claude Code: `agent-homes/<ferret>/conversation.json` (`ClaudeConversationBindingSchema`) names the conversation
 *    and the folder, and the transcript is exactly `agent-homes/<ferret>/projects/<cwd encoded>/<id>.jsonl`
 *    (`claudeTranscriptPath`); a resume runs `claude --resume <id>` in that home, so it finds the same file.
 *  - Codex: `state/codex/rollouts/<ferret>.json` (`CodexRolloutBindingSchema`: the home, no baseline, the native id) and
 *    the rollout under `agent-homes/<ferret>/sessions/…`.
 *
 * Without this a converted ferret had no transcript v5 could prove (`fy logs` refused, the chat was empty) and a
 * resume started in an empty home. So every carried ferret whose v4 config names a conversation gets its transcript
 * COPIED (bytes moved unopened, `moveSealed`) into its own home, and the binding written through the harness's own
 * schema. The v4 home stays read-only; the shared pool copy (`_shared`, the Harness folders step) stays too.
 *
 * Copy rules: the source is walked `lstat`-only from the pool or the runtime home down, and a link anywhere on it is
 * never followed — that ferret's conversation is then not carried and is named (preflight already notes the link's
 * path). Every output path goes through `V5Writer.resolve`, which refuses a link on it. A ferret with no recorded
 * conversation, or whose file is not on disk, is named in the report and never guessed.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { CODEX_ROLLOUTS, CodexRolloutBindingSchema } from '@ferretry/plugin-codex/contract';
import {
  CLAUDE_CODE_CONVERSATION_FILE,
  ClaudeConversationBindingSchema,
  claudeTranscriptPath,
  isConversationId,
} from '@ferretry/plugin-claude-code/contract';
import { moveSealed } from '../sealed.ts';
import type { NotCarried, StepReport } from '../report.ts';
import { configs, info, json, State, type V4Config } from '../v4/ferrets.ts';
import { agentHomesRoot, v4TranscriptSource } from '../v5/harness-paths.ts';
import type { Step, StepContext } from './index.ts';

/** v4's statuses of a ferret that is over: its pane, if any, is not running v4's harness any more. */
const ENDED = new Set(['completed', 'failed', 'stalled', 'stopped', 'interrupted']);

type Walk = { readonly kind: 'file'; readonly bytes: number } | { readonly kind: 'link' | 'absent' | 'other' };

/** `base/inPool`, looked at with `lstat` only, component by component from `base` down: never through a link. */
async function walk(base: string, inPool: string): Promise<Walk> {
  let at = base;
  const names = inPool.split(sep).filter(name => name !== '');
  for (let index = -1; index < names.length; index++) {
    if (index >= 0) at = join(at, names[index] ?? '');
    const facts = await info(at);
    if (facts === undefined) return { kind: 'absent' };
    if (facts.isSymbolicLink()) return { kind: 'link' };
    const last = index === names.length - 1;
    if (!last && !facts.isDirectory()) return { kind: 'other' };
    if (last) return facts.isFile() ? { kind: 'file', bytes: facts.size } : { kind: 'other' };
  }
  return { kind: 'other' };
}

interface Carried {
  readonly sealed: { file: string; bytes: number }[];
  links: number;
}

/** A real folder copied file by file (`lstat` only; a link inside it is counted and left), into `to` (v5-relative). */
async function copyFolder(ctx: StepContext, from: string, to: string, carried: Carried): Promise<void> {
  const facts = await info(from);
  if (facts === undefined) return;
  if (facts.isSymbolicLink()) {
    carried.links++;
    return;
  }
  if (facts.isDirectory()) {
    if (!ctx.dryRun) await mkdir(ctx.v5.resolve(to), { recursive: true, mode: 0o700 });
    for (const name of (await readdir(from)).sort()) await copyFolder(ctx, join(from, name), join(to, name), carried);
    return;
  }
  if (!facts.isFile()) return;
  await copyFile(ctx, from, to);
  carried.sealed.push({ file: to, bytes: facts.size });
}

/** One file's bytes, unopened, to `to` (v5-relative): its folders made owner-only first, through the link check. */
async function copyFile(ctx: StepContext, from: string, to: string): Promise<void> {
  if (ctx.dryRun) return;
  await mkdir(dirname(ctx.v5.resolve(to)), { recursive: true, mode: 0o700 });
  await moveSealed(from, ctx.v5.resolve(to));
}

/** Why a ferret's conversation was not carried, in the report's words; `undefined` when it was. */
async function carry(ctx: StepContext, config: V4Config, carried: Carried): Promise<string | undefined> {
  const native = config.transcript?.harnessSessionId;
  if (config.transcript === undefined || native === undefined || native === '')
    return 'v4 recorded no conversation for it (it never started one)';
  if (!isConversationId(native)) return 'the conversation id v4 recorded is not one plain name';
  const source = v4TranscriptSource(ctx, config.harness, config.transcript);
  if (source === undefined) return 'v4 recorded no transcript file inside its own runtime homes or shared pool';
  const found = await walk(source.base, source.inPool);
  if (found.kind === 'link') return 'its transcript path in the v4 home goes through a link, which is never followed';
  if (found.kind === 'absent') return 'the transcript v4 recorded is not on disk';
  if (found.kind !== 'file') return 'the transcript v4 recorded is not a regular file';
  const from = join(source.base, source.inPool);
  const home = join(agentHomesRoot(config.harness), config.id);
  if (config.harness === 'claude') {
    if (!config.cwd.startsWith('/'))
      return 'its v4 folder is not an absolute path, so no transcript place can be named';
    const target = join(home, claudeTranscriptPath(config.cwd, native));
    await copyFile(ctx, from, target);
    carried.sealed.push({ file: target, bytes: found.bytes });
    // The conversation's own folder beside it (sub-agent transcripts, saved tool results), when v4 kept one.
    await copyFolder(ctx, from.replace(/\.jsonl$/u, ''), target.replace(/\.jsonl$/u, ''), carried);
    await ctx.v5.json(
      { path: join(home, CLAUDE_CODE_CONVERSATION_FILE), format: 1, schema: ClaudeConversationBindingSchema },
      { format: 1, id: native, cwd: config.cwd },
    );
    return undefined;
  }
  // Codex reads rollouts under the home's `sessions/` only; an archived one keeps its dated path there.
  const dated = source.inPool.split(sep).slice(1).join(sep);
  const target = join(home, 'sessions', dated);
  await copyFile(ctx, from, target);
  carried.sealed.push({ file: target, bytes: found.bytes });
  await ctx.v5.json(
    {
      path: join('state/codex', CODEX_ROLLOUTS.path.replace('*', config.id)),
      format: CODEX_ROLLOUTS.format,
      schema: CodexRolloutBindingSchema,
    },
    { format: 1, home: ctx.v5.resolve(home), baseline: [], native },
  );
  return undefined;
}

export const ferretConversationsStep: Step = {
  id: 'ferret-conversations',
  title: "Each ferret's conversation, in its own agent home (so v5 shows and resumes it)",
  owner: ['plugin-claude-code', 'plugin-codex'],
  reads: [
    'state/sessions/<sid>/{config,state}.json',
    'fleet/shared/<claude|codex>/ (the recorded transcript only)',
    'fleet/homes/<id>/ (a recorded transcript that is a real file there)',
  ],
  sealed: [],
  notCarried: [
    {
      what: "a Claude ferret's file-history, todos, plans and shell snapshots",
      why: 'not needed to show or resume the conversation; they stay in the shared pool copy (_shared)',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] as { file: string; bytes: number }[] };
    // The preview resumes no ferret and records no conversation id (the Ferrets step), so nothing is bound.
    if (ctx.preview === true)
      return {
        ...base,
        status: 'converted',
        notCarried: [
          ...this.notCarried,
          { what: 'every ferret conversation', why: 'the preview resumes no ferret, so no conversation is bound' },
        ],
        kept: [],
      };
    try {
      const carried: Carried = { sealed: [], links: 0 };
      const missing: NotCarried[] = [];
      const stale: string[] = [];
      let count = 0;
      for (const config of await configs(ctx.v4.sessions)) {
        const why = await carry(ctx, config, carried);
        if (why !== undefined) {
          missing.push({ what: `ferret ${config.id}'s conversation`, why });
          continue;
        }
        count++;
        const state = await json(join(ctx.v4.sessions, config.id, 'state.json'), State);
        if (state !== undefined && !ENDED.has(state.status)) stale.push(config.id);
      }
      return {
        ...base,
        status: 'converted',
        ...(stale.length === 0
          ? {}
          : {
              note: `${stale.length} ferret(s) still running in v4 panes (${stale.join(', ')}): the chat shows up to conversion until restarted`,
            }),
        sealed: carried.sealed,
        notCarried: [...this.notCarried, ...missing],
        kept: [
          { what: 'ferret conversations carried into their own agent home', count },
          { what: 'links inside a conversation folder left alone', count: carried.links },
        ],
      };
    } catch {
      return {
        ...base,
        status: 'failed',
        note: "cannot carry the ferrets' conversations: invalid metadata or an unavailable file",
        notCarried: [...this.notCarried],
        kept: [],
      };
    }
  },
};
