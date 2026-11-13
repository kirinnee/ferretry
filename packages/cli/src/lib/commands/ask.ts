/**
 * `fy ask` (§2.2 Asks): lists, shows and answers the asks waiting on the owner, across every ferret, whichever plugin
 * raised them and whether or not the Agenda plugin is on.
 *
 * THE SEAM. Every ask lives on ONE ferret's board (Asks, lead decision #13), and Asks declares the per-ferret routes
 * for it (`/v1/ferrets/:ferretId/agenda…`, v4's session agenda moved under the ferret). v4 had no cross-ferret ask
 * route and no `fy ask` verb, so none is invented: this verb composes the two CORE routes that always exist (the
 * ferret list, and one board) and so every refusal, projection and grant stays the route spine's. A ferret's pane
 * reads exactly what those routes let it read, and may not answer (answering is the owner's act).
 *
 * An ask is named `<ferret>/<id>` (ids are per board: two ferrets both have an `A1`). A bare `A3` is accepted when
 * exactly one waiting ask carries it.
 */
import { skeletonSentence } from '@ferretry/kernel/contract';
import { optionOn, optionText } from '../argv.ts';
import { inPane, PERSON_ONLY_REFUSAL } from '../credential.ts';
import { DaemonRefusal, EXIT, ShellError } from '../errors.ts';
import { renderTable } from '../render.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

export const ASK_ROUTES = {
  ferrets: 'GET /v1/ferrets',
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
  /** Boards that could not be read, each with the daemon's own sentence. */
  readonly unread: readonly string[];
}

async function readBoards(ctx: ShellContext): Promise<Boards> {
  const ferrets = ferretsOf(await ctx.client(FERRETS).call(ASK_ROUTES.ferrets));
  const asks: WaitingAsk[] = [];
  const unread: string[] = [];
  const client = ctx.client(ASKS);
  for (let start = 0; start < ferrets.length; start += READ_WIDTH) {
    const reads = await Promise.all(
      ferrets.slice(start, start + READ_WIDTH).map(async ferret => {
        try {
          return waitingOn(ferret, await client.call(ASK_ROUTES.board, { params: { ferretId: ferret.id } }));
        } catch (error) {
          if (error instanceof DaemonRefusal) return `${ferret.id}: ${error.message}`;
          throw error;
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

/** `<ferret>/<id>` is exact; a bare id is looked for among the waiting asks. */
async function resolveRef(ctx: ShellContext, word: string): Promise<{ ferretId: string; id: string }> {
  const slash = word.lastIndexOf('/');
  if (slash > 0 && slash < word.length - 1) return { ferretId: word.slice(0, slash), id: word.slice(slash + 1) };
  const { asks } = await readBoards(ctx);
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
    // Answering is the owner's act: a ferret's pane is refused here, before any connection, as a person-only route is.
    if (inPane(ctx.world.environment)) throw new ShellError(PERSON_ONLY_REFUSAL, EXIT.failure);
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
