/**
 * `fy snapshot <id>` and `fy events <id>` (`fy view` is the same verb under its other name): how a person watches a
 * ferret that is already running. Moved from today's `ReadsController` (V-0442, V-0258, V-0495).
 *
 * Each is one read of the daemon through the guarded client, against the route today's path moved to when sessions
 * became ferrets (design §1.4). No manifest declares either route in this build, so the guard refuses the call with
 * "no plugin declares the route …" until its owner (Terminals for the screen, Ferrets for the journal) does; the
 * handlers do not change when it does.
 *
 * `attach` (Terminals) and `logs` (Conversation) are the plugins' own verbs and are not repeated here. `stream` needs
 * a subscription the client does not have (`PluginClient.subscribe`) and is left to the lead.
 */
import { z } from 'zod';
import { optionText } from '../argv.ts';
import { EXIT, ShellError } from '../errors.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

export const SNAPSHOT_ROUTE = 'GET /v1/ferrets/:ferretId/snapshot';
export const EVENTS_ROUTE = 'GET /v1/ferrets/:ferretId/events';

/** The daemon's page size for the journal; a bigger ask is read as several pages. */
const EVENTS_PAGE = 1_000;

/**
 * One journal event. The sequence is the cursor (a person resumes from the last one they read), and the turn is shown
 * only when the producer recorded one, because the daemon records none of its own. Other fields are tolerated: the
 * owner of the route may add to the envelope without breaking this reader.
 */
const EventSchema = z.looseObject({
  sequence: z.number().int().nonnegative(),
  time: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  turn: z.number().int().nonnegative().optional(),
  data: z.unknown().optional(),
});
type JournalEvent = z.infer<typeof EventSchema>;
const EventPageSchema = z.array(EventSchema);

/** `#12 2026-11-07T01:02:03.000Z turn.started turn=3 (daemon) {"a":1}`. */
export function renderEvent(event: JournalEvent): string {
  const turn = event.turn === undefined ? '' : ` turn=${String(event.turn)}`;
  const data = event.data === undefined || event.data === null ? '' : ` ${JSON.stringify(event.data)}`;
  return `#${String(event.sequence)} ${event.time} ${event.type}${turn} (${event.source})${data}`;
}

const usage = (message: string): ShellError => new ShellError(message, EXIT.usage);

/** The ferret every read here is about. */
function ferretArg(ctx: ShellContext, verb: string): string {
  const [ferret] = ctx.invocation.args;
  if (ferret === undefined || ferret.trim() === '')
    throw usage(`name the ferret: ${ctx.world.identity.binary} ${verb} <id>`);
  return ferret;
}

/** A whole number from an option, or `undefined` when it was not given. `min` is the smallest allowed. */
function whole(ctx: ShellContext, name: string, min: number): number | undefined {
  const text = optionText(ctx.invocation, name);
  if (text === undefined) {
    if (ctx.invocation.options[name] === true) throw usage(`--${name} needs a number`);
    return undefined;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min)
    throw usage(`--${name} must be ${min === 0 ? 'a non-negative' : 'a positive'} integer`);
  return value;
}

/** V-0442: the ferret's live screen. A dead pane is a daemon refusal, and it surfaces as one. */
export const snapshotVerb: ShellVerb = async ctx => {
  const ferretId = ferretArg(ctx, 'snapshot');
  const screen = await ctx.client('terminals').call<string>(SNAPSHOT_ROUTE, {
    params: { ferretId },
    query: { live: 'true' },
  });
  ctx.world.io.out(
    ctx.invocation.options.json === true ? `${JSON.stringify({ ferretId, snapshot: screen })}\n` : ensureLine(screen),
  );
  return EXIT.ok;
};

const ensureLine = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

/**
 * V-0258 / V-0495: one page, or every page, of the ferret's durable journal, from `--after` (default 0), at most
 * `--limit` events. Pages are read until a short one, and a page that does not move the cursor is an error rather than
 * a loop.
 */
export const eventsVerb: ShellVerb = async ctx => {
  const ferretId = ferretArg(ctx, 'events');
  const after = whole(ctx, 'after', 0) ?? 0;
  const limit = whole(ctx, 'limit', 1);
  const client = ctx.client('ferrets');
  const events: JournalEvent[] = [];
  let cursor = after;
  while (limit === undefined || events.length < limit) {
    const size = Math.min(EVENTS_PAGE, limit === undefined ? EVENTS_PAGE : limit - events.length);
    const page = EventPageSchema.parse(
      await client.call(EVENTS_ROUTE, { params: { ferretId }, query: { after: String(cursor), limit: String(size) } }),
    );
    events.push(...page);
    if (page.length < size) break;
    const next = page.at(-1)?.sequence;
    if (next === undefined || next <= cursor) throw new ShellError('event history page did not advance its cursor');
    cursor = next;
  }
  const json = ctx.invocation.options.json === true;
  for (const event of events) ctx.world.io.out(`${json ? JSON.stringify(event) : renderEvent(event)}\n`);
  return EXIT.ok;
};
