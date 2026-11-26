/**
 * The agenda tools: `list_attention`, `get_attention`, `snooze_attention` and `answer_attention`. Reading is the
 * connector's own (a whole item, sectioned and capped); the two acts are the daemon's own `resolve` and `snooze`, sent
 * through the agenda route the app uses — never `dismiss`, never `unsnooze`, never an edit.
 */
import { agendaState, agendaWakeAt, isMachineAgendaId } from '@ferretry/core-asks/contract';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import {
  ATTENTION_READ_CAP,
  type AttentionSection,
  attentionSections,
  findSection,
  renderSection,
  renderWhole,
} from '../agenda-read.ts';
import { oneLine } from '../format.ts';
import { type OpenAgendaItem, ToolFailure } from '../gateway.ts';
import { matchExact, matchName } from '../names.ts';
import {
  inWords,
  pacificWords,
  parseSnoozeDuration,
  parseSnoozeUntil,
  SNOOZE_MAX_MS,
  SNOOZE_MIN_MS,
} from '../snooze-time.ts';
import {
  askerOf,
  attentionLine,
  belongsTo,
  isAsleep,
  itemName,
  itemsNamed,
  needsTheApp,
  openForOwner,
  parseAttentionRef,
  shapeAnswer,
} from './attention-core.ts';
import { callsignOf, resolveFerret } from './ferrets.ts';
import { type ConnectorToolSpec, READ, type ToolEnvironment, WRITE } from './spec.ts';

const ATTENTION_CAP = 30;
const MESSAGE_MAX_CHARS = 8000;

const listAttention: ConnectorToolSpec<{ snoozed: z.ZodOptional<z.ZodBoolean> }> = {
  name: 'list_attention',
  title: 'List open questions',
  description:
    'List the open agenda items, the questions and approvals ferrets are waiting on the owner for: id (like A12), who asks, title and the question. This is only the summary line of each: to read one in full (its options, its context and every tab, tables included), call get_attention with its id. An item the owner snoozed (snooze_attention) is hidden until its time and listed again after; pass snoozed: true to see the ones still asleep too. Use before answering one.',
  scope: 'fleet:read',
  annotations: READ,
  input: {
    snoozed: z
      .boolean()
      .optional()
      .describe('Also list the items snoozed until later, marked with when they come back.'),
  },
  run: async ({ snoozed }, env) => {
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.ferrets()]);
    const byId = new Map<string, FerretSummary>(sessions.map(view => [view.id, view]));
    const now = env.now();
    const listable = items.filter(({ item }) => item.kind !== 'input');
    const open = listable.filter(({ item }) => openForOwner(item, now));
    const asleep = snoozed === true ? listable.filter(({ item }) => isAsleep(item, now)) : [];
    if (open.length === 0 && asleep.length === 0) return { text: 'Nothing is waiting on you.' };
    const shown = open.slice(0, ATTENTION_CAP);
    const lines = await Promise.all(shown.map(async ({ item }) => await attentionLine(env, item, byId)));
    const more = open.length > shown.length ? [`…and ${open.length - shown.length} more.`] : [];
    const sleeping = await Promise.all(
      asleep.slice(0, ATTENTION_CAP).map(async ({ item }) => {
        const wake = agendaWakeAt(item);
        return `${await attentionLine(env, item, byId)} (snoozed until ${wake === null ? 'later' : pacificWords(Date.parse(wake))})`;
      }),
    );
    return {
      text: [
        open.length === 0 ? 'Nothing is waiting on you right now.' : `${open.length} waiting on you:`,
        ...lines,
        ...more,
        ...(sleeping.length === 0 ? [] : [`${asleep.length} snoozed:`, ...sleeping]),
      ].join('\n'),
    };
  },
};

/** Every open or parked item as the name matcher sees it: its id, then its title and summary. */
const attentionKeys = (entry: OpenAgendaItem) => ({
  exact: [],
  names: [entry.item.id, ...(entry.item.title === undefined ? [] : [entry.item.title]), entry.item.subject],
});

const describeItem = async (env: ToolEnvironment, entry: OpenAgendaItem): Promise<string> =>
  `!${entry.item.id} (${await itemName(env, entry.item, 60)})`;

/** The sentence for an item that is not there: the ids it is near, else the ids that are open, so the next call can be right. */
async function noSuchItem(
  env: ToolEnvironment,
  query: string,
  readable: readonly OpenAgendaItem[],
  lead: string,
): Promise<ToolFailure> {
  if (readable.length === 0) return new ToolFailure(`${lead} Nothing is waiting on you.`);
  const result = matchName(query, readable, attentionKeys);
  const near = result.kind === 'one' ? [result.item] : result.kind === 'many' ? result.items : result.suggestions;
  if (near.length > 0) {
    const described = await Promise.all(near.slice(0, 3).map(async entry => await describeItem(env, entry)));
    return new ToolFailure(`${lead} Did you mean ${described.join(', or ')}?`);
  }
  const open = readable.slice(0, 8).map(entry => `!${entry.item.id}`);
  return new ToolFailure(
    `${lead} Open items: ${open.join(', ')}${readable.length > open.length ? `, and ${readable.length - open.length} more` : ''}.`,
  );
}

/**
 * The ONE item a caller means by `item` (and `ferret`): an id as list_attention prints it, or a title. Shared by
 * every tool that takes an item to READ or put away, so they find the same item from the same words. An id always
 * works. A title is matched loosely (one item has it, even by a part of it) only when `titles` is `fuzzy`, which
 * is for READING; to change something (`exact`) it must be the whole title. A `ferret` the caller names narrows
 * the candidates FIRST, for ids and titles alike. A value to type (`input`) is never found, as list_attention
 * never lists it: only the owner types it, in the app.
 */
async function pickAttention(
  env: ToolEnvironment,
  items: readonly OpenAgendaItem[],
  byId: ReadonlyMap<string, FerretSummary>,
  item: string,
  ferret: string | undefined,
  titles: 'fuzzy' | 'exact',
): Promise<OpenAgendaItem> {
  const readable = items.filter(({ item: each }) => each.kind !== 'input');
  const id = parseAttentionRef(item);
  if (id === undefined) {
    const wanted = ferret === undefined ? undefined : await resolveFerret(env.gateway, ferret, 'act');
    const pool = wanted === undefined ? readable : readable.filter(entry => belongsTo(entry, wanted));
    if (wanted !== undefined && pool.length === 0) throw new ToolFailure(`${callsignOf(wanted)} has no open items.`);
    const hits =
      titles === 'exact'
        ? matchExact(item, pool, attentionKeys)
        : (() => {
            const result = matchName(item, pool, attentionKeys);
            return result.kind === 'one' ? [result.item] : result.kind === 'many' ? result.items : [];
          })();
    if (hits.length > 1)
      throw new ToolFailure(
        `More than one item matches "${oneLine(item)}": ${(await Promise.all(hits.slice(0, 5).map(async entry => await describeItem(env, entry)))).join('; ')}. Which one?`,
      );
    if (hits.length === 0)
      throw await noSuchItem(
        env,
        item,
        pool,
        `"${oneLine(item)}" is not an item id (they look like A12) and no ${titles === 'exact' ? 'item has exactly that title' : 'title matches it'}.`,
      );
    return hits[0] as OpenAgendaItem;
  }
  const found = await itemsNamed(env, readable, id, ferret, () => true);
  if (found.length === 0) throw await noSuchItem(env, id, readable, `There is no open item ${id}.`);
  if (found.length > 1)
    throw new ToolFailure(
      `Item ${id} is open for more than one ferret (${found.map(entry => askerOf(entry.item, byId)).join(' and ')}). Which ferret asked?`,
    );
  return found[0] as OpenAgendaItem;
}

const getAttention: ConnectorToolSpec<{
  item: z.ZodString;
  ferret: z.ZodOptional<z.ZodString>;
  tab: z.ZodOptional<z.ZodString>;
  from: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'get_attention',
  title: 'Read one agenda item in full',
  description: `Read ONE agenda item in full, read-only: its title, who raised it and its state, the question, the options with their explanations and the recommendation, the steps, the links, the owner's earlier replies, the context, and EVERY tab by name with its full content (Markdown, tables included). Give the item id as list_attention shows it (A12, !A12 or 12). The answer is capped at ${ATTENTION_READ_CAP} characters; when a section had to be cut it says which, and you call this again with tab set to that section's name (and from, a character offset, to continue a long one). Secrets are masked.`,
  scope: 'fleet:read',
  annotations: READ,
  input: {
    item: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        'The item id, like A12, !A12 or 12, as list_attention shows it. A title also works when it is unambiguous.',
      ),
    ferret: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Only when two ferrets have an item with the same id: which one asked.'),
    tab: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Read just this section in full (still capped): "Overview", "Replies", "Context", "Detail" or a tab name.',
      ),
    from: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional()
      .describe('With tab: the character to start from, to continue a section that was cut.'),
  },
  run: async ({ item, ferret, tab, from }, env) => {
    if (from !== undefined && tab === undefined)
      throw new ToolFailure('"from" goes with "tab": which section do you want to continue?');
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.ferrets()]);
    const byId = new Map<string, FerretSummary>(sessions.map(view => [view.id, view]));
    const target = await pickAttention(env, items, byId, item, ferret, 'fuzzy');
    const owner = byId.get(target.sessionId);
    const asker = askerOf(target.item, byId);
    const raw = attentionSections(target.item, {
      asker,
      ferret: owner === undefined ? undefined : callsignOf(owner),
      appOnly: needsTheApp(target.item),
      now: env.now(),
    });
    // Cleaned BEFORE anything is cut, so a credential is never cut in half and left half-visible.
    const sections: AttentionSection[] = await Promise.all(
      raw.map(async section => ({
        id: section.id,
        name: oneLine(await env.clean(section.name)),
        text: await env.clean(section.text),
      })),
    );
    const heading = await env.clean(`!${target.item.id} — ${await itemName(env, target.item, 120)} — from ${asker}`);
    if (tab === undefined) return { text: renderWhole(heading, sections).text };
    const section = findSection(sections, tab);
    if (section === undefined)
      throw new ToolFailure(
        `Item ${target.item.id} has no section "${oneLine(tab)}". Its sections: ${sections.map(each => each.name).join('; ')}.`,
      );
    return { text: renderSection(heading, section, from ?? 0) };
  },
};

const snoozeAttention: ConnectorToolSpec<{
  item: z.ZodString;
  until: z.ZodOptional<z.ZodString>;
  duration: z.ZodOptional<z.ZodString>;
  ferret: z.ZodOptional<z.ZodString>;
}> = {
  name: 'snooze_attention',
  title: 'Snooze an open question',
  description: `Hide one open agenda item until a later time, as the app's Snooze does: list_attention stops showing it, and the daemon lists it again, fresh, at that time. Give the item id (A12, !A12 or 12, as list_attention shows it) and EITHER until (an ISO time; a time with no zone is Pacific time; "tomorrow 9am" and "17:00" also work) OR duration (like 90m, 2h or 1d). It must be at least a minute and at most ${Math.round(SNOOZE_MAX_MS / 86_400_000)} days ahead. The answer says the wake time in Pacific time. It does not answer or close the item.`,
  scope: 'fleet:write',
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    item: z.string().trim().min(1).max(200).describe('The item id, like A12, as list_attention shows it.'),
    until: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'When it comes back: an ISO time (no zone means Pacific time), "tomorrow 9am" or "17:00". Not with duration.',
      ),
    duration: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('How long to hide it: 90m, 2h, 1d or 1d 2h. Not with until.'),
    ferret: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Only when two ferrets have an item with the same id: which one asked.'),
  },
  run: async ({ item, until, duration, ferret }, env) => {
    if ((until === undefined) === (duration === undefined))
      throw new ToolFailure(
        'Say how long to snooze it with exactly one of until (a time) or duration (a wait like 2h): I need one, and not both.',
      );
    const now = env.now();
    const parsed = until !== undefined ? parseSnoozeUntil(until, now) : parseSnoozeDuration(duration as string, now);
    if (!parsed.ok) throw new ToolFailure(parsed.problem);
    if (parsed.at < now + SNOOZE_MIN_MS)
      throw new ToolFailure(
        `That is ${parsed.at <= now ? 'not in the future' : 'less than a minute ahead'}: it would be ${pacificWords(parsed.at)}. Pick a time at least a minute from now.`,
      );
    if (parsed.at > now + SNOOZE_MAX_MS)
      throw new ToolFailure(
        `That is more than ${Math.round(SNOOZE_MAX_MS / 86_400_000)} days away (${pacificWords(parsed.at)}). The latest I can snooze to is ${pacificWords(now + SNOOZE_MAX_MS)}.`,
      );
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.ferrets()]);
    const byId = new Map<string, FerretSummary>(sessions.map(view => [view.id, view]));
    const target = await pickAttention(env, items, byId, item, ferret, 'exact');
    const id = target.item.id;
    const named = `!${id} (${await itemName(env, target.item, 60)})`;
    if (agendaState(target.item).state === 'resting')
      throw new ToolFailure(`${named} is waiting on its ferret, not on you, so there is nothing to snooze.`, {
        sessionId: target.sessionId,
      });
    const wasAsleep = isAsleep(target.item, now) ? agendaWakeAt(target.item) : null;
    const wake = new Date(parsed.at).toISOString();
    try {
      await env.gateway.snoozeAgenda(target.sessionId, id, wake);
    } catch (error) {
      throw error instanceof ToolFailure ? error.aimedAt(target.sessionId) : error;
    }
    const before =
      wasAsleep === null || wasAsleep === undefined
        ? ''
        : ` It was snoozed until ${pacificWords(Date.parse(wasAsleep))}; this replaces that.`;
    // The daemon wakes a snoozed item at its `neededBy` when that comes first: say THAT time, not the one asked for.
    const effective = agendaWakeAt({
      parked: { reason: 'snoozed', at: new Date(now).toISOString(), until: wake },
      neededBy: target.item.neededBy,
    });
    const wakes = Date.parse(effective ?? wake);
    if (wakes <= now)
      return {
        text: `I snoozed ${named}, but it was needed by ${pacificWords(wakes)}, which has passed, so the daemon wakes it again at once: it stays on the owner's list.${before}`,
        sessionId: target.sessionId,
      };
    const sooner =
      wakes < parsed.at
        ? ` That is sooner than the ${pacificWords(parsed.at)} you asked for, because it is needed by ${pacificWords(wakes)}.`
        : '';
    return {
      text: `Snoozed ${named} until ${pacificWords(wakes)} (${inWords(now, wakes)}).${sooner} It will not show in list_attention until then, and comes back on the owner's list at that time.${before}`,
      sessionId: target.sessionId,
    };
  },
};

const answerAttention: ConnectorToolSpec<{
  item: z.ZodString;
  answer: z.ZodString;
  ferret: z.ZodOptional<z.ZodString>;
  version: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'answer_attention',
  title: 'Answer an open question',
  description:
    'Answer one open agenda item (a question or approval a ferret is waiting on). Give the item id like A12 (list_attention shows them) and the answer in words: for a choice, the option; for an approval, approve or reject; otherwise the text.',
  scope: 'fleet:write',
  annotations: WRITE,
  input: {
    item: z.string().trim().min(1).max(20).describe('The item id, like A12.'),
    answer: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).describe('The answer.'),
    ferret: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Only when two ferrets have an item with the same id: which one asked.'),
    version: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        'Only for an item marked "revised": the version number it names, so the answer is for the question that was read out.',
      ),
  },
  run: async ({ item, answer, ferret, version }, env) => {
    const id = parseAttentionRef(item);
    if (id === undefined) throw new ToolFailure(`"${oneLine(item)}" is not an item id. Ids look like A12.`);
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.ferrets()]);
    const byId = new Map<string, FerretSummary>(sessions.map(view => [view.id, view]));
    const now = env.now();
    const found = await itemsNamed(env, items, id, ferret, item => openForOwner(item, now));
    if (found.length === 0) throw new ToolFailure(`There is no open item ${id}. Ask me to list what is waiting.`);
    if (found.length > 1) {
      const askers = found.map(entry => askerOf(entry.item, byId)).join(' and ');
      throw new ToolFailure(`Item ${id} is open for more than one ferret (${askers}). Which ferret asked?`);
    }
    const target = found[0] as (typeof found)[number];
    // The answer is for the question the owner heard. A question a ferret has revised since it was first asked can only be
    // answered by naming its version, which list_attention and get_attention say when they read it out: a stale reading
    // (no version, or an older one) is refused with the question as it is now, and nothing is sent.
    if ((version ?? 1) !== (target.item.askVersion ?? 1)) {
      throw new ToolFailure(
        `That question changed, so nothing was sent; here it is now: ${await attentionLine(env, target.item, byId)}`,
        { sessionId: target.sessionId },
      );
    }
    const shaped = shapeAnswer(target.item, answer);
    if (shaped.kind === 'refuse')
      throw new ToolFailure(shaped.sentence, { refused: shaped.refused, sessionId: target.sessionId });
    // The machine's own list takes a bare resolve (an id and a note) and has nowhere to put a decision: an answer that is
    // a choice, a verdict or a permission would be dropped and still reported as given. Say so instead of pretending.
    if (shaped.kind === 'response' && isMachineAgendaId(target.sessionId))
      throw new ToolFailure("That one is on the machine's own list, and only the Ferretry app can answer it.", {
        refused: true,
        sessionId: target.sessionId,
      });
    const response = shaped.kind === 'response' ? shaped.response : undefined;
    try {
      await env.gateway.resolveAgenda(
        target.sessionId,
        id,
        target.item.askVersion ?? 1,
        response,
        shaped.kind === 'done' ? answer : undefined,
      );
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'ask_changed') throw await changedAsk(env, target, id, byId);
      throw error instanceof ToolFailure ? error.aimedAt(target.sessionId) : error;
    }
    return { text: `Answered ${id} from ${askerOf(target.item, byId)}.`, sessionId: target.sessionId };
  },
};

/**
 * The ferret replaced the ask between the moment the answer was shaped and the moment it landed. Nothing was
 * applied; say what the item asks NOW so the owner can answer the question they have not yet heard.
 */
async function changedAsk(
  env: ToolEnvironment,
  target: OpenAgendaItem,
  id: string,
  byId: ReadonlyMap<string, FerretSummary>,
): Promise<ToolFailure> {
  const at = env.now();
  const now = (await env.gateway.openAgenda()).find(
    entry => entry.sessionId === target.sessionId && entry.item.id === id && openForOwner(entry.item, at),
  );
  const sessionId = target.sessionId;
  if (now === undefined)
    return new ToolFailure(`That question changed and ${id} is not open any more. Nothing was sent.`, { sessionId });
  return new ToolFailure(
    `That question changed, so nothing was sent; here it is now: ${await attentionLine(env, now.item, byId)}`,
    { sessionId },
  );
}

export const ATTENTION_TOOLS = [listAttention, getAttention, snoozeAttention, answerAttention] as const;
