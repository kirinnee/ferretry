import type { CliContext, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import type {
  KeepResult,
  LinkListing,
  LinkPreview,
  TranscriptPage,
  WorkHit,
  WorkSearchResponse,
} from '../../contract/index.ts';
import { RENDER_GUIDE_TYPES, renderGuideSection, renderGuideSectionName } from './guide.ts';
import { RENDER_GUIDE_SECTION } from './guide-text.ts';

/** What the reading verbs need of the CLI: the generated client and the terminal. */
type Context = Pick<CliContext<never>, 'client' | 'io'>;

const BIN = 'fy';

const option = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const flag = (invocation: VerbInvocation, name: string): boolean => invocation.options[name] === true;
const words = (invocation: VerbInvocation): string => invocation.args.join(' ').trim();

/** A refusal said in one sentence on stderr, exit code 2 (a usage error), as the CLI's controllers do. */
class Usage extends Error {}

const number = (invocation: VerbInvocation, name: string): number | undefined => {
  const typed = option(invocation, name);
  if (typed === undefined) return undefined;
  const value = Number(typed);
  if (!Number.isInteger(value) || value < 0) throw new Usage(`--${name} is a whole number`);
  return value;
};

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const clip = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

/** `&F303` for a card, `!A3` for an ask: how a hit is cited. */
const reference = (hit: WorkHit): string => `${hit.kind === 'card' ? '&' : '!'}${hit.id}`;

/** The matching line, unless it only repeats the title or the id the reader already sees. */
const matchLine = (hit: WorkHit): string => {
  if (hit.match.field === 'id' || hit.match.field === 'title') return '';
  const line = flat(hit.match.line);
  return line === '' || line === flat(hit.title) ? '' : clip(line, 100);
};

/** Hits as aligned lines: `&F303  card  In progress  Title — the matching line`. */
export function renderHits(hits: readonly WorkHit[], own: string | undefined): string[] {
  const rows = hits.map(hit => ({ hit, ref: reference(hit) }));
  const refWidth = Math.max(0, ...rows.map(row => row.ref.length));
  const kindWidth = Math.max(0, ...rows.map(row => row.hit.kind.length));
  const standingWidth = Math.max(0, ...rows.map(row => row.hit.standing.length));
  return rows.map(({ hit, ref }) => {
    const match = matchLine(hit);
    const mine = hit.kind === 'ask' && own !== undefined && hit.ferret === own;
    return [
      `${ref.padEnd(refWidth)}  ${hit.kind.padEnd(kindWidth)}  ${hit.standing.padEnd(standingWidth)}  ${flat(hit.title)}`,
      match === '' ? '' : ` — ${match}`,
      mine ? `  (yours — ${BIN} agenda edit ${hit.id})` : '',
    ].join('');
  });
}

function renderListing(listing: LinkListing): string {
  if (listing.conversations.length === 0) return 'No conversations match.';
  const lines = listing.conversations.map(row => {
    const kept = row.keptBy === undefined ? '' : `  (kept by ${row.keptBy})`;
    const floor = row.turnsAtLeast === true ? '+' : '';
    return `${row.id}  ${row.harness}  ${row.lastActivityAt.slice(0, 16).replace('T', ' ')}  ${String(row.turns)}${floor} turns  ${row.name ?? clip(flat(row.preview), 60)}${kept}`;
  });
  const more = listing.matched > listing.conversations.length ? [`Showing ${String(listing.conversations.length)} of ${String(listing.matched)}.`] : [];
  const skipped = listing.skipped > 0 ? [`${String(listing.skipped)} could not be read and are not listed.`] : [];
  return [...lines, ...more, ...skipped].join('\n');
}

function renderKeep(result: KeepResult): string {
  return [
    ...result.kept.map(each => `kept ${each.id} as ${each.name} (${each.ferret}, ${each.state})`),
    ...result.refused.map(each => `refused ${each.id}: ${each.reason}`),
  ].join('\n');
}

function renderTranscriptPage(page: TranscriptPage): string {
  const lines = page.messages.map(message => `${message.point}  ${message.role}: ${flat(message.text)}`);
  const next = page.nextCursor === null ? [] : [`next: --cursor ${page.nextCursor}`];
  return [...lines, ...next].join('\n');
}

/**
 * The reading verbs: logs, search, render guide, link (list, preview, keep) and transcript. Each is one client call and one
 * rendering; a refusal is a sentence on stderr and a non-zero exit, never a stack.
 */
export function readingVerbs({ client, io }: Context) {
  const guarded =
    (run: (invocation: VerbInvocation) => Promise<number | void>): VerbHandler =>
    async invocation => {
      try {
        return (await run(invocation)) ?? 0;
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : String(error)}\n`);
        return error instanceof Usage ? 2 : 1;
      }
    };
  const print = (text: string): void => io.out(text.endsWith('\n') ? text : `${text}\n`);

  const guide = guarded(async invocation => {
    const type = invocation.args[0];
    if (type === undefined) {
      const commands = RENDER_GUIDE_TYPES.map(each => `${BIN} render guide ${each}`).join('\n');
      print(`${section('overview')}\n\n${commands}`);
      return;
    }
    const name = renderGuideSectionName(type);
    if (name === undefined) throw new Usage(`no type ${type} — one of ${RENDER_GUIDE_TYPES.join(', ')}`);
    print(section(name));
  });
  const section = (name: string): string => {
    const body = renderGuideSection(RENDER_GUIDE_SECTION, name);
    if (body === undefined || body === '') throw new Error(`the shipped guide has no ### ${name} section`);
    return body;
  };

  return {
    /** R265: the tail of a ferret's own transcript, as text. `--turn` reads one explicitly bounded turn. */
    logs: guarded(async invocation => {
      const ferret = invocation.args[0];
      if (ferret === undefined) throw new Usage(`name the ferret: ${BIN} logs <ferret>`);
      const turn = number(invocation, 'turn');
      const limit = number(invocation, 'limit');
      const query = { ...(turn === undefined ? {} : { turn: String(turn) }), ...(limit === undefined ? {} : { limit: String(limit) }) };
      print(await client.call<string>('GET /v1/ferrets/:ferretId/logs', { params: { ferretId: ferret }, query }));
    }),

    search: guarded(async invocation => {
      const query = words(invocation);
      if (query === '') throw new Usage(`say what to look for: ${BIN} search <words...>`);
      const kind = option(invocation, 'kind');
      if (kind !== undefined && kind !== 'card' && kind !== 'ask') throw new Usage('--kind is one of card | ask');
      const limit = number(invocation, 'limit');
      const answer = await client.call<WorkSearchResponse>('GET /v1/search', {
        query: {
          q: query,
          ...(kind === undefined ? {} : { kind }),
          ...(flag(invocation, 'open') ? { open: 'true' } : {}),
          ...(flag(invocation, 'all') ? { all: 'true' } : {}),
          ...(option(invocation, 'project') === undefined ? {} : { project: option(invocation, 'project') as string }),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      });
      if (flag(invocation, 'json')) return print(JSON.stringify(answer, null, 2));
      const older =
        answer.olderHidden === undefined || answer.olderHidden < 1
          ? []
          : [`${String(answer.olderHidden)} older closed ${answer.olderHidden === 1 ? 'item' : 'items'} hidden — ${BIN} search --all ${query}`];
      if (answer.hits.length === 0) {
        const subject = kind === 'card' ? 'cards' : kind === 'ask' ? 'asks' : 'cards or asks';
        return print([`No ${subject} match “${query}”.`, ...older].join('\n'));
      }
      const more =
        answer.total > answer.hits.length
          ? [`Showing ${String(answer.hits.length)} of ${String(answer.total)}; narrow it with --kind, --open or --project, or raise --limit.`]
          : [];
      print([...renderHits(answer.hits, option(invocation, 'ferret')), ...more, ...older].join('\n'));
    }),

    /** `fy render` with nothing after it is the guide, as it always was. */
    render: guide,
    'render guide': guide,

    link: guarded(async invocation => {
      const q = words(invocation);
      const limit = number(invocation, 'limit');
      const listing = await client.call<LinkListing>('GET /v1/links/conversations', {
        query: {
          ...(q === '' ? {} : { q }),
          ...(option(invocation, 'harness') === undefined ? {} : { harness: option(invocation, 'harness') as string }),
          ...(option(invocation, 'source') === undefined ? {} : { source: option(invocation, 'source') as string }),
          ...(option(invocation, 'since') === undefined ? {} : { since: option(invocation, 'since') as string }),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      });
      print(flag(invocation, 'json') ? JSON.stringify(listing, null, 2) : renderListing(listing));
    }),

    'link preview': guarded(async invocation => {
      const [harness, id] = invocation.args;
      if (harness === undefined || id === undefined) throw new Usage(`${BIN} link preview <harness> <conversation-id>`);
      const preview = await client.call<LinkPreview>('GET /v1/links/conversations/:harness/:conversationId/preview', {
        params: { harness, conversationId: id },
      });
      print(
        flag(invocation, 'json')
          ? JSON.stringify(preview, null, 2)
          : preview.messages.map(message => `${message.role}: ${flat(message.text)}`).join('\n'),
      );
    }),

    /** Q19: keeping LINKS the conversation (read from the harness's own file); a copy is a separate request. */
    'link keep': guarded(async invocation => {
      const [harness, runtime, ...ids] = invocation.args;
      if (harness === undefined || runtime === undefined || ids.length === 0)
        throw new Usage(`${BIN} link keep <harness> <runtime> <conversation-id...> [--start]`);
      const result = await client.call<KeepResult>('POST /v1/links/conversations/keep', {
        body: { harness, runtime, conversations: ids.map(id => ({ id, start: flag(invocation, 'start') })) },
      });
      print(flag(invocation, 'json') ? JSON.stringify(result, null, 2) : renderKeep(result));
      return result.refused.length > 0 ? 1 : 0;
    }),

    /** G41: a page of the conversation as rows a caller may act on. `--tail` reads the newest, `--through` ends at a row. */
    transcript: guarded(async invocation => {
      const ferret = invocation.args[0];
      if (ferret === undefined) throw new Usage(`name the ferret: ${BIN} transcript <ferret>`);
      const limit = number(invocation, 'limit');
      const page = await client.call<TranscriptPage>('GET /v1/ferrets/:ferretId/messages', {
        params: { ferretId: ferret },
        query: {
          ...(option(invocation, 'cursor') === undefined ? {} : { cursor: option(invocation, 'cursor') as string }),
          ...(option(invocation, 'through') === undefined ? {} : { through: option(invocation, 'through') as string }),
          ...(flag(invocation, 'tail') ? { tail: '1' } : {}),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      });
      print(flag(invocation, 'json') ? JSON.stringify(page, null, 2) : renderTranscriptPage(page));
    }),
  } as const;
}
