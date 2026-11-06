import type {
  AgendaItem,
  AgendaOpenSession,
  AgendaOptionDetail,
  AgendaResponse,
  AgendaSnapshot,
  AgendaUndeliveredReply,
  ResolvedAgendaItem,
} from './agenda.ts';

/**
 * THE LEGACY PROJECTION (docs/agenda.md § An older app keeps reading the board).
 *
 * An app that shipped before the channel parses a WHOLE snapshot with its own schema, so one item it cannot read
 * makes the board unreadable. The channel widened what an item may say (longer bodies, steps, notes and answers),
 * added two revisable fields (`whereWeAre`, `detail`) and a `response` on history entries, where revisions and
 * history entries are strict. A machine therefore serves the items an app has not said it understands (the request
 * header `x-fy-agenda-channel: 1`, advertised as `agenda.channel.1` on `GET /v1/health`) in this shape: the same
 * items, clipped to the bounds that app held, with the channel-only parts left out. It is a view, never written back.
 */

/** The request header that says a caller reads the whole channel shape; its value is the channel version. */
export const AGENDA_CHANNEL_HEADER = 'x-fy-agenda-channel';
/** Current reader version: channel fields plus resolved headers on list reads. Version 1 still reads full records. */
export const AGENDA_CHANNEL_VERSION = '2';

/** The bounds the app before the channel held, for the fields the channel widened. */
export const LEGACY_AGENDA_LIMITS = {
  text: 2_048,
  points: 1_024,
  step: 2_000,
  body: 8_000,
  optionDetail: 1_000,
} as const;

/** The revisable fields an app before the channel does not know. */
const CHANNEL_ONLY_FIELDS: ReadonlySet<string> = new Set(['whereWeAre', 'detail', 'tabs']);

/** The item keys only the channel carries: an older app ignores them, so a projection does not send them. */
const CHANNEL_ONLY_KEYS = ['resting', 'ownerAnswer', 'stage', 'stages', 'whereWeAre', 'detail', 'tabs'] as const;

/** What an older app is told under the body when the item has tabs it cannot draw (`agenda.tabs.1`). */
const moreTabsLine = (names: readonly string[]): string =>
  `_This item has more tabs (${names.join(', ')}): update the app to read them._`;

/** Links without the `meaning` an older app's strict link schema refuses (`agenda.link-meaning.1`). */
function withoutLinkMeanings(fields: Record<string, unknown>): void {
  if (!Array.isArray(fields.links)) return;
  fields.links = fields.links.map(entry => {
    if (typeof entry !== 'object' || entry === null || !('meaning' in entry)) return entry;
    const { meaning: _meaning, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
}

const POINT_KEYS = ['premise', 'decided', 'stillOpen', 'impact'] as const;

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/** An item's fields (or a revision's `previous`), with every one the channel widened clipped to the older bound. */
function clippedFields<T extends object>(fields: T): T {
  const out = { ...fields } as Record<string, unknown>;
  for (const key of POINT_KEYS) {
    const value = out[key];
    if (typeof value === 'string') out[key] = clip(value, LEGACY_AGENDA_LIMITS.points);
  }
  if (typeof out.context === 'string') out.context = clip(out.context, LEGACY_AGENDA_LIMITS.text);
  if (typeof out.body === 'string') out.body = clip(out.body, LEGACY_AGENDA_LIMITS.body);
  if (typeof out.questionAnswer === 'string') out.questionAnswer = clip(out.questionAnswer, LEGACY_AGENDA_LIMITS.body);
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map(step => (typeof step === 'string' ? clip(step, LEGACY_AGENDA_LIMITS.step) : step));
  }
  if (Array.isArray(out.optionDetails)) {
    out.optionDetails = (out.optionDetails as readonly AgendaOptionDetail[]).map(option => ({
      ...option,
      detail: clip(option.detail, LEGACY_AGENDA_LIMITS.optionDetail),
    }));
  }
  return out as T;
}

/** An owner response with its free text clipped to the older bound; the other kinds carry nothing long. */
function clippedResponse(response: AgendaResponse): AgendaResponse {
  const limit = LEGACY_AGENDA_LIMITS.text;
  switch (response.kind) {
    case 'open-question':
    case 'other':
      return { ...response, answer: clip(response.answer, limit) };
    case 'answer-review':
      return response.verdict === 'clarify'
        ? { ...response, clarification: clip(response.clarification, limit) }
        : response;
    case 'form':
      return {
        ...response,
        answers: response.answers.map(answer => ({
          ...answer,
          picked: Array.isArray(answer.picked)
            ? answer.picked.map(each => clip(each, limit))
            : clip(answer.picked, limit),
        })),
      };
    default:
      return response;
  }
}

/** The item without the keys only the channel carries, its revisions and history cut to what the older app reads. */
function projected<T extends AgendaItem>(item: T): T {
  const bag: Record<string, unknown> = { ...clippedFields(item) };
  for (const key of CHANNEL_ONLY_KEYS) delete bag[key];
  withoutLinkMeanings(bag);
  const hidden = [
    ...(item.whereWeAre === undefined ? [] : ['Where we are now']),
    ...(item.tabs ?? []).map(tab => tab.name),
  ];
  if (item.tabs !== undefined) {
    const line = moreTabsLine(hidden);
    const body = typeof bag.body === 'string' ? bag.body : '';
    bag.body = body === '' ? line : `${clip(body, LEGACY_AGENDA_LIMITS.body - line.length - 2)}\n\n${line}`;
  }
  if (item.undelivered !== undefined) {
    const reply = item.undelivered.reply;
    bag.undelivered = {
      ...item.undelivered,
      reply: {
        ...reply,
        ...(reply.note === undefined ? {} : { note: clip(reply.note, LEGACY_AGENDA_LIMITS.text) }),
        ...('response' in reply && reply.response !== undefined ? { response: clippedResponse(reply.response) } : {}),
      },
    };
  }
  const revisions = (item.revisions ?? []).flatMap(revision => {
    const changed = revision.changed.filter(field => !CHANNEL_ONLY_FIELDS.has(field));
    if (changed.length === 0) return [];
    const previous: Record<string, unknown> = { ...clippedFields(revision.previous) };
    for (const field of CHANNEL_ONLY_FIELDS) delete previous[field];
    withoutLinkMeanings(previous);
    return [{ ...revision, changed, previous }];
  });
  if (revisions.length === 0) delete bag.revisions;
  else bag.revisions = revisions;
  if (item.history !== undefined) {
    bag.history = item.history.map(({ response: _response, note, ...entry }) => ({
      ...entry,
      ...(note === undefined ? {} : { note: clip(note, LEGACY_AGENDA_LIMITS.text) }),
    }));
  }
  return bag as T;
}

/** One open item as an app before the channel reads it. */
export const legacyAgendaItem = (item: AgendaItem): AgendaItem => projected(item);

/** An exact legacy Retry replays the stored words, also before any gate/confirmation side effect. */
export function restoredLegacyAgendaReply<T extends AgendaUndeliveredReply>(item: AgendaItem, reply: T): T {
  const stored = item.undelivered?.reply;
  const expected = legacyAgendaItem(item).undelivered?.reply;
  if (
    stored === undefined ||
    expected === undefined ||
    expected.action !== reply.action ||
    expected.note !== reply.note
  )
    return reply;
  const response = 'response' in reply ? reply.response : undefined;
  const projectedResponse = 'response' in expected ? expected.response : undefined;
  return JSON.stringify(response) === JSON.stringify(projectedResponse) ? ({ ...reply, ...stored } as T) : reply;
}

/** One closed item as an app before the channel reads it. */
export function legacyResolvedAgendaItem(item: ResolvedAgendaItem): ResolvedAgendaItem {
  const closed = projected(item);
  return {
    ...closed,
    resolutionNote: closed.resolutionNote === null ? null : clip(closed.resolutionNote, LEGACY_AGENDA_LIMITS.text),
    ...(closed.response === undefined ? {} : { response: clippedResponse(closed.response) }),
  };
}

/** A board snapshot as an app before the channel reads it. */
export const legacyAgendaSnapshot = (snapshot: AgendaSnapshot): AgendaSnapshot => ({
  ...snapshot,
  items: snapshot.items.map(legacyAgendaItem),
  resolved: snapshot.resolved.map(legacyResolvedAgendaItem),
});

/** One conversation's roll-up items as an app before the channel reads them. */
export const legacyAgendaOpenSession = (session: AgendaOpenSession): AgendaOpenSession => ({
  ...session,
  items: session.items.map(legacyAgendaItem),
});

/** Both supported reader versions understand the full channel fields; absent/unknown versions get legacy fields. */
export const readsAgendaChannel = (headers: { get(name: string): string | null | undefined }): boolean => {
  const version = headers.get(AGENDA_CHANNEL_HEADER)?.trim();
  return version === '1' || version === AGENDA_CHANNEL_VERSION;
};

/** Only channel 2 readers can parse resolved headers in list responses. */
export const readsAgendaHeaders = (headers: { get(name: string): string | null | undefined }): boolean =>
  headers.get(AGENDA_CHANNEL_HEADER)?.trim() === AGENDA_CHANNEL_VERSION;
