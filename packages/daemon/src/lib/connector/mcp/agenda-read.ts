/**
 * Reading ONE agenda item in full, for `get_attention` — pure: the item in, named sections of text out, then
 * a budget that decides how much of each section fits in one answer.
 *
 * WHY SECTIONS. The agenda is the main channel between the owner and Claude, and an item's richest content lives
 * in its TABS (Markdown, tables included, up to 200 000 characters each). A tool result cannot carry all of that
 * at once, so the item is split into named sections — the overview (who, what, the question, the options), the
 * owner's earlier replies, the context, then every tab in the order the app draws them (`agendaTabs`) and the
 * from-zero detail — and the answer says exactly which were cut and how to fetch each one whole.
 *
 * THE BUDGET IS FAIR, NOT FIRST-COME. A first tab of 100 000 characters must not push every later tab out of the
 * answer, so the room is shared by water-filling: every section gets what it needs or the same share as the other
 * long ones, whichever is smaller. A short tab is therefore always whole, and every long one shows its start.
 *
 * Nothing here cleans text: the caller passes every section through the connector's one redaction door BEFORE it
 * is cut, so a credential is never cut in half and left half-visible.
 */

import {
  type AgendaItem,
  type AgendaResponse,
  agendaCardKind,
  agendaState,
  agendaTabs,
  findAgendaTab,
} from '@ferretry/protocol';
import { ago } from './format.ts';

/** The most one `get_attention` answer carries, in characters (docs/mcp-connector.md says why this number). */
export const ATTENTION_READ_CAP = 24_000;

/** The most earlier replies the replies section lists (the newest), so a long thread cannot crowd out the rest. */
const REPLIES_LISTED = 20;

/** What the room is reserved for besides the sections: the heading, the cut notice and the section marker lines. */
const MARKER_ROOM = 220;

export interface AttentionSection {
  /** Lower-case, stable: what `tab` may name besides the section's name. */
  readonly id: string;
  /** What the reader sees in the heading, and what `tab` may name in any case. */
  readonly name: string;
  readonly text: string;
}

export interface AttentionContext {
  /** Who raised it, as the connector says it ("Lizzette", "you", "Ferretry"). */
  readonly asker: string;
  /** The callsign of the ferret whose board holds the item, when there is one (not the machine ledger). */
  readonly ferret: string | undefined;
  /** True when only the Ferretry app can answer it (a passkey act, a form, a typed value). */
  readonly appOnly: boolean;
  readonly now: number;
}

const filled = (text: string | null | undefined): text is string =>
  text !== undefined && text !== null && text.trim() !== '';

/** "Label: text" on one line when the text is one line, else the label alone and the text under it. */
function field(label: string, text: string | null | undefined): string[] {
  if (!filled(text)) return [];
  const body = text.trim();
  return body.includes('\n') ? [`${label}:`, body] : [`${label}: ${body}`];
}

/** What an answer the owner gave says, in words. */
function responseWords(response: AgendaResponse): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'approved' : 'rejected';
    case 'multiple-choice':
      return `chose "${response.choice}"`;
    case 'answer-review':
      return response.verdict === 'good' ? 'said it is good' : `asked for changes: ${response.clarification}`;
    case 'open-question':
      return response.answer;
    case 'other':
      return `none of the options: ${response.answer}`;
    case 'form':
      return response.answers
        .map(entry => `${entry.id} = ${Array.isArray(entry.picked) ? entry.picked.join(', ') : entry.picked}`)
        .join('; ');
  }
}

function stateWords(item: AgendaItem): string {
  const state = agendaState(item);
  switch (state.state) {
    case 'needs-you':
      return 'open, waiting for you';
    case 'snoozed':
      return item.parked?.reason === 'snoozed' ? `snoozed until ${item.parked.until}` : 'snoozed';
    case 'resting':
      return item.waitingFor === 'discussion'
        ? 'in discussion with its ferret'
        : state.sub === 'working'
          ? 'the ferret is working on it'
          : 'waiting on its ferret';
    case 'done':
      return item.notice === true ? 'a notice' : 'closed';
  }
}

function optionLines(item: AgendaItem): string[] {
  if (item.ask?.kind !== 'multiple-choice') return [];
  const details = new Map((item.optionDetails ?? []).map(entry => [entry.label.trim().toLowerCase(), entry.detail]));
  return item.ask.options.flatMap(option => {
    const detail = details.get(option.label.trim().toLowerCase());
    const head = `- ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`;
    return detail === undefined
      ? [head]
      : [
          head,
          ...detail
            .trim()
            .split('\n')
            .map(line => `    ${line}`),
        ];
  });
}

function overviewOf(item: AgendaItem, who: AttentionContext): string {
  const title = item.title?.trim();
  const kind = agendaCardKind(item);
  const lines: string[] = [
    `Title: ${filled(title) ? title : item.subject}`,
    ...(filled(title) && title !== item.subject ? [`Summary: ${item.subject}`] : []),
    `Raised by: ${who.asker}${who.ferret === undefined || who.ferret === who.asker ? '' : ` (on ${who.ferret}'s agenda)`}`,
    `State: ${stateWords(item)}. Kind: ${kind}.`,
    `Waiting since: ${item.waitingSince} (${ago(who.now, item.waitingSince)}).`,
    ...(who.appOnly ? ['Only the Ferretry app can answer this one (it needs a passkey or a form).'] : []),
    ...field('The question', item.why),
  ];
  if (item.ask !== undefined && item.ask.kind !== 'multiple-choice') lines.push(`Answer shape: ${item.ask.kind}.`);
  const options = optionLines(item);
  if (options.length > 0) lines.push('Options:', ...options);
  if (item.recommendation !== undefined)
    lines.push(
      ...field(
        'Recommended',
        `${item.recommendation.decision}${filled(item.recommendation.why) ? ` — ${item.recommendation.why}` : ''}`,
      ),
    );
  (item.questions ?? []).forEach((question, index) => {
    lines.push(`Question ${index + 1}: ${question.question.trim()}`);
    for (const option of question.options ?? [])
      lines.push(`- ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`);
    if (question.recommended !== undefined) lines.push(`  Recommended: ${question.recommended}`);
    if (filled(question.why)) lines.push(`  Why: ${question.why.trim()}`);
  });
  (item.fields ?? []).forEach(entry => {
    const picks = (entry.options ?? []).map(option => option.label);
    lines.push(
      `Form field ${entry.id} (${entry.type}${entry.required === true ? ', required' : ''}): ${entry.label.trim()}${picks.length === 0 ? '' : ` [${picks.join(' | ')}]`}`,
    );
  });
  lines.push(...field('Premise', item.premise));
  lines.push(...field('If nobody answers', item.impact));
  lines.push(...field('Urgency', item.urgency));
  if (item.neededBy !== undefined) lines.push(`Needed by: ${item.neededBy}`);
  if (item.blockingNow === true) lines.push('It is blocking the ferret right now.');
  else lines.push(...field('Will block', item.willBlock));
  lines.push(...field('How to resolve', item.howToResolve));
  if (item.steps !== undefined) {
    const done = new Set(item.stepsDone ?? []);
    lines.push('Steps:');
    item.steps.forEach((step, index) => {
      lines.push(`${index + 1}. [${done.has(index) ? 'x' : ' '}] ${step.trim()}`);
    });
  }
  if (item.links !== undefined) {
    lines.push('Links:');
    for (const link of item.links)
      lines.push(
        `- ${filled(link.label) ? `${link.label}: ` : ''}${link.target}${filled(link.meaning) ? ` — ${link.meaning}` : ''}`,
      );
  }
  if (item.terms !== undefined) {
    lines.push('Terms:');
    for (const term of item.terms) lines.push(`- ${term.term}: ${term.meaning}`);
  }
  for (const ask of item.cardAsks ?? [])
    if (filled(ask.howToTest))
      lines.push(`How to test (${ask.gate.cardTitle ?? ask.gate.cardId}, ${ask.gate.laneName}):`, ask.howToTest.trim());
  return lines.join('\n');
}

/** The owner's latest answer, then the thread (the newest {@link REPLIES_LISTED} entries), then the earlier replies the record keeps. */
function repliesOf(item: AgendaItem, now: number): string {
  const lines: string[] = [];
  if (item.ownerAnswer !== undefined) {
    const answer = item.ownerAnswer;
    lines.push(
      `Latest answer from the owner (${ago(now, answer.at)}): ${responseWords(answer.response)}${filled(answer.note) ? ` — note: ${answer.note}` : ''}`,
    );
  }
  const thread = item.conversation ?? [];
  if (thread.length > 0) {
    const shown = thread.slice(-REPLIES_LISTED);
    const earlier = (item.conversationCount ?? thread.length) - shown.length;
    lines.push(
      earlier > 0 ? `The conversation (the last ${shown.length}; ${earlier} earlier not shown):` : 'The conversation:',
    );
    for (const entry of shown) lines.push(`[${entry.by}, ${entry.via}, ${ago(now, entry.at)}] ${entry.text.trim()}`);
  } else {
    // Items from before the conversation was kept: what the history recorded of the owner's words.
    const said = (item.history ?? []).filter(entry => filled(entry.note) || entry.response !== undefined);
    if (said.length > 0) {
      lines.push('What was said before:');
      for (const entry of said)
        lines.push(
          `[${entry.kind}, ${ago(now, entry.at)}] ${[entry.response === undefined ? undefined : responseWords(entry.response), entry.note].filter(filled).join(' — ')}`,
        );
    }
  }
  return lines.join('\n');
}

/**
 * The item as named sections, in the order a reader wants them: overview, replies, context, then the tabs as the
 * app draws them, then the from-zero detail. An empty section is left out. A tab's text is its Markdown exactly
 * as written, so a table stays a table.
 */
export function attentionSections(item: AgendaItem, who: AttentionContext): readonly AttentionSection[] {
  const tabs = agendaTabs(item).map((tab): AttentionSection => {
    if (tab.kind !== 'main') return { id: tab.id, name: tab.name, text: tab.body };
    const parts = [
      ...(filled(tab.questionAnswer) ? [`The ferret's answer to your question:\n${tab.questionAnswer.trim()}`] : []),
      ...(filled(tab.decided) ? [`Decided:\n${tab.decided.trim()}`] : []),
      ...(filled(tab.stillOpen) ? [`Still open:\n${tab.stillOpen.trim()}`] : []),
      ...(filled(tab.whereWeAre) ? [tab.whereWeAre.trim()] : []),
    ];
    return { id: tab.id, name: tab.name, text: parts.join('\n\n') };
  });
  const taken = new Set(tabs.flatMap(tab => [tab.id, tab.name.toLowerCase()]));
  // An item's own tab may be called "Context"; the item's field then says "(item)", so a name never means two things.
  const fixed = (id: string, name: string, text: string): AttentionSection[] =>
    text.trim() === ''
      ? []
      : [
          taken.has(id) || taken.has(name.toLowerCase())
            ? { id: `${id}-item`, name: `${name} (item)`, text }
            : { id, name, text },
        ];
  return [
    ...fixed('overview', 'Overview', overviewOf(item, who)),
    ...fixed('replies', 'Replies', repliesOf(item, who.now)),
    ...fixed('context', 'Context', filled(item.context) ? item.context.trim() : ''),
    ...tabs,
    ...fixed('detail', 'Detail', filled(item.detail) ? item.detail.trim() : ''),
  ];
}

/** The section `ref` names — its name in any case, else its id — or undefined. */
export function findSection(sections: readonly AttentionSection[], ref: string): AttentionSection | undefined {
  const at = findAgendaTab(sections, ref);
  return at < 0 ? undefined : sections[at];
}

/**
 * How many characters each section may show when `room` is shared: the water level. A section no longer than the
 * level shows whole; a longer one shows the level. Deterministic, and never above `room` in total.
 */
export function shares(lengths: readonly number[], room: number): number[] {
  if (lengths.reduce((sum, length) => sum + length, 0) <= room) return [...lengths];
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = Math.max(0, room);
  let level = 0;
  for (const [index, length] of sorted.entries()) {
    const slots = sorted.length - index;
    if (length * slots <= left) {
      left -= length;
      level = length;
    } else {
      level = Math.floor(left / slots);
      break;
    }
  }
  return lengths.map(length => Math.min(length, level));
}

/** `text` cut to at most `max` characters, on a line break when one is near, so a table row is not cut in half. */
export function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, Math.max(0, max));
  const lineBreak = hard.lastIndexOf('\n');
  return lineBreak > max * 0.5 ? hard.slice(0, lineBreak) : hard;
}

export interface RenderedAttention {
  readonly text: string;
  /** The names of the sections that were cut. */
  readonly cut: readonly string[];
}

/**
 * The answer for the WHOLE item: a heading, the list of sections, a notice naming each cut section and how to read
 * it, then the sections within {@link ATTENTION_READ_CAP}.
 */
export function renderWhole(heading: string, sections: readonly AttentionSection[]): RenderedAttention {
  const names = sections.map(section => section.name);
  const head = `${heading}\nSections: ${names.join('; ')}.`;
  const lengths = sections.map(section => section.text.length);
  const fixed = head.length + sections.reduce((sum, section) => sum + section.name.length + 8, 0);
  const fits = lengths.reduce((sum, length) => sum + length, 0) + fixed <= ATTENTION_READ_CAP;
  const room = ATTENTION_READ_CAP - fixed - (fits ? 0 : MARKER_ROOM + 140 * sections.length);
  const each = fits ? lengths : shares(lengths, room);
  const cut: string[] = [];
  const blocks = sections.map((section, index) => {
    const shown = cutAtLine(section.text, each[index] ?? 0);
    if (shown.length >= section.text.length) return `## ${section.name}\n${section.text}`;
    cut.push(section.name);
    return `## ${section.name}\n${shown}\n[… cut here: ${section.text.length - shown.length} more characters. Call get_attention again with tab "${section.name}" to read it whole.]`;
  });
  const notice =
    cut.length === 0
      ? []
      : [
          `Clipped to fit one answer. Cut: ${cut.join('; ')}. Ask for one of them with the tab argument to read it in full.`,
        ];
  return { text: [head, ...notice, '', ...blocks.flatMap(block => [block, ''])].join('\n').trimEnd(), cut };
}

/**
 * The answer for ONE section, from character `from`, still capped: when more remains the answer says where to
 * continue, so a tab of 200 000 characters is reachable in a few calls and nothing is out of reach.
 */
export function renderSection(heading: string, section: AttentionSection, from: number): string {
  const total = section.text.length;
  if (from >= total && total > 0)
    return `${heading}\n## ${section.name}\nThat is past the end: this section is ${total} characters long.`;
  const room = ATTENTION_READ_CAP - heading.length - section.name.length - 400;
  const piece = cutAtLine(section.text.slice(from), room);
  const end = from + piece.length;
  const range = from === 0 && end >= total ? '' : ` (characters ${from}–${end} of ${total})`;
  const more =
    end < total
      ? `\n[… ${total - end} more characters. Call get_attention again with tab "${section.name}" and from ${end} to continue.]`
      : '';
  return `${heading}\n## ${section.name}${range}\n${piece}${more}`;
}
