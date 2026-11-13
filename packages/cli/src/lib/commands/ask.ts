/**
 * `fy ask` (§2.2 Asks): lists, shows and answers the asks waiting on the owner, across every ferret, whichever plugin
 * raised them and whether or not the Agenda plugin is on.
 *
 * THE SEAM. Every ask lives on ONE ferret's board (Asks, lead decision #13), and Asks declares the per-ferret routes
 * for it (`/v1/ferrets/:ferretId/agenda…`, v4's session agenda moved under the ferret). v4 had no cross-ferret ask
 * route and no `fy ask` verb, so none is invented: this verb composes the CORE routes that always exist (the live
 * ferret list, the archived ferret list, and one board) and so every refusal, projection and grant stays the route
 * spine's. The archived list matters: the live list leaves out a ferret that is archived AND stopped, yet an ask can
 * still be raised on its board, and the Agenda app shows it. A ferret's pane reads exactly what those routes let it
 * read, and answers exactly what the daemon lets it answer: an ordinary ask on its OWN board (the 2026-11-07 ruling
 * recorded in the Asks owner-only-answers test). Any other answer is refused by the daemon, and its sentence is printed.
 *
 * An ask is named `<ferret>/<id>` (ids are per board: two ferrets both have an `A1`). A bare `A3` is accepted when
 * exactly one waiting ask carries it.
 */
import { skeletonSentence } from '@ferretry/kernel/contract';
import { optionOn, optionText } from '../argv.ts';
import { EXIT, ShellError } from '../errors.ts';
import { renderTable } from '../render.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

export const ASK_ROUTES = {
  ferrets: 'GET /v1/ferrets',
  archived: 'GET /v1/archived-sessions',
  board: 'GET /v1/ferrets/:ferretId/agenda',
  item: 'GET /v1/ferrets/:ferretId/agenda/:id',
  answer: 'POST /v1/ferrets/:ferretId/agenda',
} as const;

const ASKS = 'asks';
const FERRETS = 'ferrets';
/** How many boards are read at once. */
const READ_WIDTH = 8;

const ONE_ANSWER =
  'give exactly one answer: --approve/--reject, --yes/--no, --choice, --good/--clarify, --answer (or the words), --other, or --done';

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

const shape = (what: string): ShellError =>
  new ShellError(`the daemon answered ${what} in a shape this fy does not read`);

interface Ferret {
  readonly id: string;
  readonly name: string;
}

/** The ferrets a list answer names. */
export function ferretsOf(body: unknown): readonly Ferret[] {
  if (!Array.isArray(body)) throw shape('the ferret list');
  return body.map(entry => {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.id !== 'string' || row.id === '') throw shape('the ferret list');
    return { id: row.id, name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id };
  });
}

/** The most archived ferrets one read returns (the route's own ceiling). */
const ARCHIVED_LIMIT = 500;

/** The archived ferrets an archive answer names (each is a full view: its identity is under `config`). */
export function archivedOf(body: unknown): { readonly ferrets: readonly Ferret[]; readonly count: number } {
  const answer = body as { count?: unknown; sessions?: unknown } | null;
  if (
    answer === null ||
    typeof answer !== 'object' ||
    !Array.isArray(answer.sessions) ||
    typeof answer.count !== 'number'
  )
    throw shape('the archived ferret list');
  const ferrets = answer.sessions.map(entry => {
    const config = (entry as { config?: Record<string, unknown> } | null)?.config;
    if (typeof config?.id !== 'string' || config.id === '') throw shape('the archived ferret list');
    // The callsign (`teammate`), as the live list's `name` is: `config.name` is the task title.
    const callsign = [config.teammate, config.name].find(value => typeof value === 'string' && value !== '');
    return { id: config.id, name: typeof callsign === 'string' ? callsign : config.id };
  });
  return { ferrets, count: answer.count };
}

/** One ask waiting on the owner. */
export interface WaitingAsk {
  readonly ferret: Ferret;
  readonly id: string;
  readonly kind: string;
  readonly asking: string;
  readonly since: string;
}

/** The asks on one board whose turn is the owner's: not a notice, not parked, not waiting on the ferret. */
export function waitingOn(ferret: Ferret, board: unknown): readonly WaitingAsk[] {
  const items = (board as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw shape(`the board of ${ferret.id}`);
  return items
    .map(item => item as Record<string, unknown>)
    .filter(
      item =>
        typeof item.id === 'string' &&
        item.resolvedAt === undefined &&
        item.notice !== true &&
        item.parked === undefined &&
        item.waitingOn !== 'ferret',
    )
    .map(item => ({
      ferret,
      id: text(item.id),
      kind: text(item.kind) || text((item.ask as { kind?: unknown } | undefined)?.kind),
      asking: text(item.title).trim() || text(item.subject),
      since: text(item.waitingSince),
    }));
}

const refOf = (ask: WaitingAsk): string => `${ask.ferret.id}/${ask.id}`;

/** An ask as the list shows it, oldest first. */
export function askRows(asks: readonly WaitingAsk[]): readonly string[][] {
  return [...asks]
    .sort((left, right) => left.since.localeCompare(right.since))
    .map(ask => [refOf(ask), ask.ferret.name, ask.kind, ask.asking]);
}

interface Boards {
  readonly asks: readonly WaitingAsk[];
  /** Boards (or ferret lists) that could not be read, each with what went wrong. */
  readonly unread: readonly string[];
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every ferret a board could be on: the live ones, then the archived ones the live list leaves out. */
async function ferretsToRead(ctx: ShellContext, unread: string[]): Promise<readonly Ferret[]> {
  const live = ferretsOf(await ctx.client(FERRETS).call(ASK_ROUTES.ferrets));
  const known = new Set(live.map(ferret => ferret.id));
  try {
    const { ferrets, count } = archivedOf(
      await ctx.client(FERRETS).call(ASK_ROUTES.archived, { query: { limit: String(ARCHIVED_LIMIT) } }),
    );
    if (count > ferrets.length)
      unread.push(
        `${String(count - ferrets.length)} older archived ferrets (only the newest ${String(ferrets.length)} were read)`,
      );
    return [...live, ...ferrets.filter(ferret => !known.has(ferret.id))];
  } catch (error) {
    unread.push(`the archived ferrets: ${reason(error)}`);
    return live;
  }
}

async function readBoards(ctx: ShellContext): Promise<Boards> {
  const unread: string[] = [];
  const ferrets = await ferretsToRead(ctx, unread);
  const asks: WaitingAsk[] = [];
  const client = ctx.client(ASKS);
  for (let start = 0; start < ferrets.length; start += READ_WIDTH) {
    const reads = await Promise.all(
      ferrets.slice(start, start + READ_WIDTH).map(async ferret => {
        try {
          return waitingOn(ferret, await client.call(ASK_ROUTES.board, { params: { ferretId: ferret.id } }));
        } catch (error) {
          // A refusal, a timeout and a board in a shape this fy cannot read are all one board that could not be read:
          // it is named, and the boards that could be read are still shown.
          return `${ferret.id}: ${reason(error)}`;
        }
      }),
    );
    for (const read of reads) {
      if (typeof read === 'string') unread.push(read);
      else asks.push(...read);
    }
  }
  return { asks, unread };
}

/** `<ferret>/<id>` is exact; a bare id is looked for among the waiting asks, and only when every board was read. */
async function resolveRef(ctx: ShellContext, word: string): Promise<{ ferretId: string; id: string }> {
  const slash = word.lastIndexOf('/');
  if (slash > 0 && slash < word.length - 1) return { ferretId: word.slice(0, slash), id: word.slice(slash + 1) };
  const { asks, unread } = await readBoards(ctx);
  // Ids are per board, so a bare id is unique only if every board was looked at: never act on an unproven match.
  if (unread.length > 0)
    throw new ShellError(
      `cannot tell whether ${word} is on more than one ferret, because these could not be read: ${unread.join('; ')}. Say which ask, as <ferret>/${word}`,
    );
  const found = asks.filter(ask => ask.id === word);
  const only = found[0];
  if (only === undefined) throw new ShellError(`no ask ${word} is waiting`);
  if (found.length > 1)
    throw new ShellError(
      `${word} is on more than one ferret: say which, as ${found.map(refOf).join(' or ')}`,
      EXIT.usage,
    );
  return { ferretId: only.ferret.id, id: only.id };
}

const required = (value: string, flag: string, what: string): string => {
  const trimmed = value.trim();
  if (trimmed === '') throw new ShellError(`${flag} needs ${what}`, EXIT.usage);
  return trimmed;
};

/** The response an `ask answer` carries (v4's `agenda done` flags); `undefined` for a bare Done. */
function answerOf(ctx: ShellContext, words: readonly string[]): { readonly response?: unknown } {
  const { invocation } = ctx;
  const on = (name: string): boolean => optionOn(invocation, name);
  const typed =
    optionText(invocation, 'answer') ??
    optionText(invocation, 'text') ??
    (words.length > 0 ? words.join(' ') : undefined);
  const choice = optionText(invocation, 'choice');
  const clarify = optionText(invocation, 'clarify');
  const other = optionText(invocation, 'other');
  const given = [
    on('approve') || on('reject'),
    on('yes') || on('no'),
    choice !== undefined,
    on('good') || clarify !== undefined,
    typed !== undefined,
    other !== undefined,
    on('done'),
  ].filter(Boolean).length;
  const usage = `usage: ${ctx.world.identity.binary} ask answer <ask> <text>  (or --approve, --reject, --yes, --no, --choice <label>, --good, --clarify <text>, --other <text>, --done)`;
  if (given === 0) throw new ShellError(usage, EXIT.usage);
  if (given > 1 || (on('approve') && on('reject')) || (on('yes') && on('no')) || (on('good') && clarify !== undefined))
    throw new ShellError(ONE_ANSWER, EXIT.usage);
  if (on('done')) return {};
  if (on('approve') || on('reject'))
    return { response: { kind: 'permission', decision: on('approve') ? 'approve' : 'reject' } };
  if (on('yes') || on('no')) return { response: { kind: 'multiple-choice', choice: on('yes') ? 'Yes' : 'No' } };
  if (choice !== undefined)
    return {
      response: { kind: 'multiple-choice', choice: required(choice, '--choice', 'the label of one listed option') },
    };
  if (on('good')) return { response: { kind: 'answer-review', verdict: 'good' } };
  if (clarify !== undefined)
    return {
      response: {
        kind: 'answer-review',
        verdict: 'clarify',
        clarification: required(clarify, '--clarify', 'the clarification text'),
      },
    };
  if (other !== undefined)
    return { response: { kind: 'other', answer: required(other, '--other', 'the answer text') } };
  return { response: { kind: 'open-question', answer: required(typed ?? '', '--answer', 'the answer text') } };
}

export const askVerb: ShellVerb = async ctx => {
  const { io, identity } = ctx.world;
  const declared = Object.values(ASK_ROUTES).every(route => ctx.surfaces.routes.has(route));
  if (!declared) {
    io.err(`${skeletonSentence(ctx.surfaces.titles[ASKS] ?? 'Asks')}\n`);
    return EXIT.unavailable;
  }
  const [first, ...rest] = ctx.invocation.args;
  if (first === undefined || first === 'list') {
    const { asks, unread } = await readBoards(ctx);
    io.out(
      asks.length === 0
        ? 'no asks are waiting\n'
        : `${renderTable(['ASK', 'FERRET', 'KIND', 'ASKING'], askRows(asks))}\n`,
    );
    for (const line of unread) io.err(`could not read the asks of ${line}\n`);
    return unread.length === 0 ? EXIT.ok : EXIT.failure;
  }
  if (first === 'show') {
    const word = rest[0];
    if (word === undefined) throw new ShellError(`usage: ${identity.binary} ask show <ask>`, EXIT.usage);
    const { ferretId, id } = await resolveRef(ctx, word);
    const item = await ctx.client(ASKS).call(ASK_ROUTES.item, { params: { ferretId, id } });
    io.out(`${JSON.stringify(item, null, 2)}\n`);
    return EXIT.ok;
  }
  if (first === 'answer') {
    // No pane refusal here: who may answer is the daemon's rule (an ordinary ask on a ferret's own board; the owner for
    // every other), and its refusal sentence is what is printed.
    const word = rest[0];
    if (word === undefined)
      throw new ShellError(`usage: ${identity.binary} ask answer <ask> <text>  (or --text "...")`, EXIT.usage);
    const body = answerOf(ctx, rest.slice(1));
    const { ferretId, id } = await resolveRef(ctx, word);
    await ctx.client(ASKS).call(ASK_ROUTES.answer, { params: { ferretId }, body: { action: 'resolve', id, ...body } });
    io.out(`answered ${ferretId}/${id}\n`);
    return EXIT.ok;
  }
  throw new ShellError(`usage: ${identity.binary} ask [list | show <ask> | answer <ask> <text>]`, EXIT.usage);
};
