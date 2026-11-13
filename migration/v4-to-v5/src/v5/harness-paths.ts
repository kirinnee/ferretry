import { CLAUDE_CODE_AGENT_HOMES } from '@ferretry/plugin-claude-code/contract';
import { CODEX_AGENT_HOMES } from '@ferretry/plugin-codex/contract';
import type { TranscriptProvenance } from '@ferretry/core-ferrets/contract';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { StepContext } from '../steps/index.ts';
import type { RuntimeIds } from '../v4/ferrets.ts';
import { rebaseV4Path } from '../v4/rebase.ts';

export function agentHomesRoot(harness: 'claude' | 'codex') {
  const declaration = harness === 'claude' ? CLAUDE_CODE_AGENT_HOMES : CODEX_AGENT_HOMES;
  return join('state', harness === 'claude' ? 'claude-code' : 'codex', declaration.path.replace(/\/\*$/u, ''));
}

/** `child` relative to `parent`, or `undefined` when it is not an absolute path inside it. */
export function inside(parent: string, child: string) {
  if (!isAbsolute(child)) return undefined;
  const path = relative(resolve(parent), resolve(child));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path;
}

/** The preview home's own folder for ferrets that lost theirs (`prepare` makes it). */
export const PREVIEW_WORKSPACE = 'workspace';

/**
 * The preview's folder for a ferret: `folder` unchanged, unless a resumed ferret there would run a new agent in a
 * checkout a live v4 agent works in: a folder inside v4's home or its managed worktree root (the `-worktrees` sibling),
 * inside a worktree v4's ledger lists (`worktrees`, from the copied `state/worktrees.json`), or with a `/.worktrees/`
 * segment (the repo-local worktrees most checkouts on this box are). Those ferrets get the preview's own empty
 * `workspace` folder, and the dry run and the gaps say they lost their folder. A primary checkout keeps its folder.
 */
export function previewFolder(ctx: StepContext, folder: string, worktrees: readonly string[] = []): string {
  const home = ctx.previewV4Home;
  if (ctx.preview !== true || home === undefined) return folder;
  const shared =
    inside(home, folder) !== undefined ||
    inside(`${home}-worktrees`, folder) !== undefined ||
    worktrees.some(path => inside(path, folder) !== undefined) ||
    /(^|\/)\.worktrees(\/|$)/u.test(folder);
  return shared ? ctx.v5.resolve(PREVIEW_WORKSPACE) : folder;
}

/** Rewrite metadata only. Never read a transcript or follow its former home links. */
export function rewriteTranscript(
  ctx: StepContext,
  harness: 'claude' | 'codex',
  recorded: TranscriptProvenance,
  ids: z.infer<typeof RuntimeIds> | undefined,
): TranscriptProvenance | undefined {
  // The pointer was written with v4's home where it was then: a moved or copied home has it re-based onto `--from` first.
  const transcript: TranscriptProvenance = {
    ...recorded,
    home: rebaseV4Path(ctx.v4.home, recorded.home),
    ...(recorded.file === undefined ? {} : { file: rebaseV4Path(ctx.v4.home, recorded.file) }),
  };
  const homes = join(ctx.v4.fleet, 'homes');
  const local = inside(homes, transcript.home);
  if (local === undefined || local.length === 0 || local.includes(sep)) return undefined;
  const entry = Object.values(ids?.runtimes ?? {}).find(
    value => resolve(homes, rebaseV4Path(ctx.v4.home, value.home ?? value.id)) === resolve(transcript.home),
  );
  const id = entry?.id ?? (z.uuid().safeParse(local).success ? local : undefined);
  if (id === undefined) return undefined;
  const root = agentHomesRoot(harness);
  const home = ctx.v5.resolve(join(root, id));
  if (transcript.file === undefined) return { ...transcript, home };
  const pooled = inside(join(ctx.v4.fleet, 'shared', harness), transcript.file);
  if (pooled !== undefined && pooled.length > 0)
    return { ...transcript, home, file: ctx.v5.resolve(join(root, '_shared', pooled)) };
  const inHome = inside(transcript.home, transcript.file);
  if (inHome === undefined || inHome.length === 0) return undefined;
  // v4 pools these transcript paths. The old home held symlinks; metadata points straight at the copied pool.
  const first = inHome.split(sep)[0];
  const isPooled = harness === 'claude' ? first === 'projects' : first === 'sessions' || first === 'archived_sessions';
  return { ...transcript, home, file: ctx.v5.resolve(join(root, isPooled ? '_shared' : id, inHome)) };
}

/**
 * Where v4 keeps a ferret's transcript BYTES, for carrying them into the ferret's own v5 agent home: the shared pool
 * (`fleet/shared/<harness>/…`) for a pooled path — reached directly, never through the account home's link into it —
 * or a real file inside the runtime's own home (`fleet/homes/<id>/…`). `inPool` is the path below the pool or that home
 * (`projects/<dir>/<id>.jsonl`, `sessions/YYYY/MM/DD/<rollout>.jsonl`). `undefined` when v4 recorded no file, or one
 * outside both. Pure path work: the caller walks it lstat-only.
 */
export function v4TranscriptSource(
  ctx: StepContext,
  harness: 'claude' | 'codex',
  recorded: TranscriptProvenance,
): { readonly base: string; readonly inPool: string } | undefined {
  if (recorded.file === undefined) return undefined;
  const home = rebaseV4Path(ctx.v4.home, recorded.home);
  const file = rebaseV4Path(ctx.v4.home, recorded.file);
  const pool = join(ctx.v4.fleet, 'shared', harness);
  const pooled = inside(pool, file);
  if (pooled !== undefined && pooled.length > 0) return { base: pool, inPool: pooled };
  const homes = join(ctx.v4.fleet, 'homes');
  const local = inside(homes, home);
  if (local === undefined || local.length === 0 || local.includes(sep)) return undefined;
  const inHome = inside(home, file);
  if (inHome === undefined || inHome.length === 0) return undefined;
  const first = inHome.split(sep)[0];
  const isPooled = harness === 'claude' ? first === 'projects' : first === 'sessions' || first === 'archived_sessions';
  return isPooled ? { base: pool, inPool: inHome } : { base: join(homes, local), inPool: inHome };
}
