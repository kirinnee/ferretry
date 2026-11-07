/**
 * `fy stream [id]` (V-0452): follow one ferret, or every ferret, until interrupted. Ported from today's `ReadsController`
 * onto the guarded client's `subscribe`, so the feed is opened, judged and closed by the one client every verb uses.
 *
 * What a live follower hears is what the daemon publishes: Ferrets' `ferrets.changed` (a ferret was added, changed
 * state, or went away). Today's per-session journal needs a sequence cursor the event bus does not carry, so `--after`
 * is refused with that reason rather than ignored.
 *
 * `attach` (Terminals) and `logs` (Conversation) are the plugins' own verbs and are not repeated here. `snapshot` and
 * `events` belong to Terminals (V-0442) and Ferrets (V-0258) and are not shell verbs.
 */
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { EXIT, ShellError } from '../errors.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

type Change = typeof FerretsChanged extends { schema: { _output: infer Output } } ? Output : never;

/** `ada working (generation 3)`, `ada gone (generation 4)`. */
export function renderChange(change: { ferret: string; generation: number; state?: string; gone?: true }): string {
  const what = change.gone === true ? 'gone' : (change.state ?? 'changed');
  return `${change.ferret} ${what} (generation ${String(change.generation)})`;
}

const usage = (message: string): ShellError => new ShellError(message, EXIT.usage);

/** The ferret named on the line, `undefined` for the whole daemon. */
function followed(ctx: ShellContext): string | undefined {
  const { args, options } = ctx.invocation;
  const binary = ctx.world.identity.binary;
  if (args.length > 1) throw usage(`${binary} stream follows one ferret or all of them: ${binary} stream [id]`);
  if (options.after !== undefined)
    throw usage(
      `${binary} stream has no --after: a live stream carries changes as they happen and the daemon keeps no ` +
        `sequence for them to resume from`,
    );
  const ferret = args[0]?.trim();
  return ferret === undefined || ferret === '' ? undefined : ferret;
}

/** V-0452: prints each change as it happens, one line each (`--json`: the event as one JSON line), until interrupted. */
export const streamVerb: ShellVerb = async ctx => {
  const ferret = followed(ctx);
  const { io } = ctx.world;
  const json = ctx.invocation.options.json === true;
  const interrupt = ctx.world.interrupt?.();
  const ended = Promise.withResolvers<string | undefined>();
  const stopHearing = ctx.client('ferrets').follow(
    FerretsChanged,
    (change: Change) => {
      if (ferret !== undefined && change.ferret !== ferret) return;
      io.out(`${json ? JSON.stringify(change) : renderChange(change)}\n`);
    },
    reason => ended.resolve(reason),
  );
  interrupt?.signal.addEventListener('abort', () => ended.resolve(undefined), { once: true });
  if (interrupt?.signal.aborted === true) ended.resolve(undefined);
  const reason = await ended.promise;
  stopHearing();
  interrupt?.release();
  if (reason === undefined) return EXIT.ok;
  io.err(`${ctx.world.identity.binary} stream: ${reason}\n`);
  return EXIT.failure;
};
