/**
 * `fy ask` (§2.2 Asks): lists and answers the asks waiting, whichever plugin raised them and whether or not the
 * Agenda plugin is on. It speaks only to the routes Asks declares; with none declared it says Asks is not built yet.
 *
 * ASSUMPTION, one place: the route keys below. Reconcile with the Asks manifest when its routes land.
 */
import { skeletonSentence } from '@ferretry/kernel/contract';
import { optionText } from '../argv.ts';
import { EXIT, ShellError } from '../errors.ts';
import { renderTable } from '../render.ts';
import type { ShellVerb } from '../shell-context.ts';

export const ASK_ROUTES = {
  list: 'GET /v1/asks',
  show: 'GET /v1/asks/:id',
  answer: 'POST /v1/asks/:id/answer',
} as const;

const ASKS = 'asks';

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

/** An ask as the list shows it: tolerant of fields Asks adds, strict about the three it must have. */
export function askRows(body: unknown): readonly string[][] {
  const items = Array.isArray(body) ? body : (body as { asks?: unknown } | null)?.asks;
  if (!Array.isArray(items)) throw new ShellError('the daemon answered the asks list in a shape this fy does not read');
  return items.map(item => {
    const ask = item as Record<string, unknown>;
    return [text(ask.id), text(ask.source), text(ask.title ?? ask.question)];
  });
}

export const askVerb: ShellVerb = async ctx => {
  const { io, identity } = ctx.world;
  if (!ctx.surfaces.routes.has(ASK_ROUTES.list)) {
    io.err(`${skeletonSentence(ctx.surfaces.titles[ASKS] ?? 'Asks')}\n`);
    return EXIT.unavailable;
  }
  const client = ctx.client(ASKS);
  const [first, ...rest] = ctx.invocation.args;
  if (first === undefined || first === 'list') {
    const rows = askRows(await client.call(ASK_ROUTES.list));
    io.out(rows.length === 0 ? 'no asks are waiting\n' : `${renderTable(['ASK', 'FROM', 'ASKING'], rows)}\n`);
    return EXIT.ok;
  }
  if (first === 'show') {
    const id = rest[0];
    if (id === undefined) throw new ShellError(`usage: ${identity.binary} ask show <id>`, EXIT.usage);
    io.out(`${JSON.stringify(await client.call(ASK_ROUTES.show, { params: { id } }), null, 2)}\n`);
    return EXIT.ok;
  }
  if (first === 'answer') {
    const id = rest[0];
    const answer = optionText(ctx.invocation, 'text') ?? rest.slice(1).join(' ');
    if (id === undefined || answer === '')
      throw new ShellError(`usage: ${identity.binary} ask answer <id> <text>  (or --text "...")`, EXIT.usage);
    await client.call(ASK_ROUTES.answer, { params: { id }, body: { answer } });
    io.out(`answered ${id}\n`);
    return EXIT.ok;
  }
  throw new ShellError(`usage: ${identity.binary} ask [list | show <id> | answer <id> <text>]`, EXIT.usage);
};
