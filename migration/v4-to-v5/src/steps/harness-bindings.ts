import { mkdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CODEX_ROLLOUTS, CodexRolloutBindingSchema } from '@ferretry/plugin-codex/contract';
import { agentHomesRoot, historyPoolRoot } from '../v5/harness-paths.ts';
import type { StepContext } from './index.ts';

/** The least of a v4 session record this needs (`configs()` rows satisfy it). */
export interface BindableSession {
  readonly id: string;
  readonly harness: 'claude' | 'codex';
  readonly cwd: string;
  readonly transcript?: { readonly harnessSessionId?: string | undefined } | undefined;
}

/**
 * A conversation id is one plain name, as the Claude reader requires (`isConversationId` in the plugin's own
 * `claude-path.ts`, which a converter cannot import): restated here so a value the reader would refuse is never written.
 */
const PLAIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

/** Makes the link the v5 harness's `poolHistory` makes (an absolute link to the pool's entry), unless a name is already there. */
async function linkToPool(
  ctx: StepContext,
  home: string,
  harness: 'claude' | 'codex',
  entry: string,
): Promise<boolean> {
  const target = ctx.v5.resolve(join(historyPoolRoot(harness), entry));
  const at = ctx.v5.resolve(join(home, entry));
  // The pool entry is made now when v4 had none (0700, as the kernel makes it), so a link never points at nothing.
  await mkdir(target, { mode: 0o700, recursive: true });
  await mkdir(dirname(at), { mode: 0o700, recursive: true });
  try {
    await symlink(target, at);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    // Already there: only the pool's own link counts as bound.
    return (await readlink(at).catch(() => undefined)) === target;
  }
}

/**
 * Makes every converted ferret that has a v4 harness conversation readable BEFORE it is resumed. v5 proves a transcript
 * from a binding in the ferret's own home (Claude: `conversation.json`; Codex: the `rollouts` state record), not from the
 * ferret record, and reads through the history pool only when the home links to it (`projects` / `sessions`). v4 homes
 * are copied as opaque files and v4 held neither, so without this a converted, stopped ferret's chat said "no transcript
 * this daemon can prove is its own" until it was resumed once. A session with no recorded conversation gets nothing.
 *
 * Preview runs carry no conversation id (the ferret record names none), so nothing is bound there. Returns how many
 * ferrets of each harness were bound.
 */
export async function bindConvertedHistory(
  ctx: StepContext,
  sessions: readonly BindableSession[],
): Promise<{ readonly claude: number; readonly codex: number }> {
  const bound = { claude: 0, codex: 0 };
  if (ctx.preview === true) return bound;
  for (const session of sessions) {
    const conversation = session.transcript?.harnessSessionId;
    if (conversation === undefined) continue;
    const home = join(agentHomesRoot(session.harness), session.id);
    if (session.harness === 'claude') {
      if (!PLAIN_ID.test(conversation) || !session.cwd.startsWith('/')) continue;
      bound.claude++;
      if (ctx.dryRun) continue;
      await ctx.v5.opaque(
        join(home, 'conversation.json'),
        `${JSON.stringify({ format: 1, id: conversation, cwd: session.cwd })}\n`,
      );
      await linkToPool(ctx, home, 'claude', 'projects');
      continue;
    }
    bound.codex++;
    if (ctx.dryRun) continue;
    // `native` names the conversation, so the rollout is proved by its id alone, in the pool, exactly as a resume's is.
    await ctx.v5.json(
      {
        path: join('state/codex', CODEX_ROLLOUTS.path.replace('*', session.id)),
        format: 1,
        schema: CodexRolloutBindingSchema,
      },
      { format: 1, home: ctx.v5.resolve(home), baseline: [], native: conversation },
    );
    await linkToPool(ctx, home, 'codex', 'sessions');
  }
  return bound;
}
