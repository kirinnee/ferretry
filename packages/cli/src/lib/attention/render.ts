import type { AttentionAsk, AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { describeAnswer } from './answer.ts';
import { attentionOrdinal, attentionReference } from './reference.ts';

/** Widest a field is printed at before it is elided. */
const BODY_WIDTH = 84;
const SHORT_WIDTH = 60;
const SUBJECT_WIDTH = 56;
const OPTION_WIDTH = 32;

const INDENT = '      ';

const compact = (value: string, width = BODY_WIDTH): string => {
  const line = value.replaceAll(/\s+/gu, ' ').trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

const pluralItems = (count: number): string => (count === 1 ? '1 unresolved item' : `${count} unresolved items`);

/** Who acted: an agent is named where the daemon knows the name. */
function actor(by: 'human' | 'agent' | 'daemon', name: string | null): string {
  if (by !== 'agent') return by;
  return name === null ? 'agent' : `agent ${name}`;
}

/** What the human has to do to clear the item. */
function askLine(ask: AttentionAsk | undefined): string | undefined {
  if (ask === undefined) return undefined;
  switch (ask.kind) {
    case 'permission':
      return 'answer: approve or reject';
    case 'multiple-choice':
      return `answer: pick one of ${ask.options.map(option => `"${compact(option.label, OPTION_WIDTH)}"`).join(' | ')}`;
    case 'answer-review':
      return 'answer: good, or ask to clarify';
    case 'open-question':
      return 'answer: write a full answer';
  }
}

/**
 * Oldest first — the order the listing header has always claimed.
 *
 * kteam printed that header and then rendered whatever order the daemon happened to send, so the
 * promise was decorative. Ties break on the item ordinal, which is monotonic per session.
 */
function oldestFirst(left: AttentionItem, right: AttentionItem): number {
  if (left.waitingSince !== right.waitingSince) return left.waitingSince < right.waitingSince ? -1 : 1;
  return attentionOrdinal(left.id) - attentionOrdinal(right.id);
}

/** Newest first: a resolution audit is read from the most recent entry back. */
function newestFirst(left: ResolvedAttentionItem, right: ResolvedAttentionItem): number {
  if (left.resolvedAt !== right.resolvedAt) return left.resolvedAt < right.resolvedAt ? 1 : -1;
  return attentionOrdinal(right.id) - attentionOrdinal(left.id);
}

function itemLines(item: AttentionItem): string[] {
  const lines = [`  ${attentionReference(item.id)}  [${item.source}]  ${compact(item.subject)}`];
  const ask = askLine(item.ask);
  if (ask !== undefined) lines.push(`${INDENT}${ask}`);
  if (item.context !== null && item.context !== undefined && item.context.trim() !== '') {
    lines.push(`${INDENT}context: ${compact(item.context)}`);
  }
  lines.push(`${INDENT}why: ${compact(item.why)}`);
  lines.push(`${INDENT}resolve: ${compact(item.howToResolve)}`);
  lines.push(`${INDENT}since ${item.waitingSince} · raised by ${actor(item.raisedBy, item.raisedByName)}`);
  return lines;
}

/**
 * A warning about unreadable entries, which never replaces the readable ones.
 *
 * kteam returned only this warning and dropped the whole list, so one corrupt record hid every valid
 * item on the board — exactly when a human most needs to see what is waiting.
 */
function parseErrorWarning(snapshot: AttentionSnapshot): string | undefined {
  if (snapshot.parseErrors === 0) return undefined;
  const entries = snapshot.parseErrors === 1 ? '1 entry' : `${snapshot.parseErrors} entries`;
  return `Warning: ${entries} on this board could not be read; the list below may be incomplete.`;
}

/** The unresolved board as a human reads it. */
export function renderAttentionList(snapshot: AttentionSnapshot): string {
  const warning = parseErrorWarning(snapshot);
  const preamble = warning === undefined ? [] : [warning];
  if (snapshot.items.length === 0) return [...preamble, 'Nothing needs attention.'].join('\n');

  const header = `${pluralItems(snapshot.count)} in ${snapshot.sessionId} — oldest first`;
  const body = [...snapshot.items].sort(oldestFirst).flatMap(itemLines);
  return [...preamble, header, ...body].join('\n');
}

function resolutionLine(item: ResolvedAttentionItem): string {
  const verb = item.disposition === 'dismissed' ? 'dismissed' : 'resolved';
  const answer = item.response === undefined ? '' : ` — ${compact(describeAnswer(item.response), SHORT_WIDTH)}`;
  const note =
    item.resolutionNote === null || item.resolutionNote.trim() === ''
      ? ''
      : ` — ${compact(item.resolutionNote, SHORT_WIDTH)}`;
  const who = actor(item.resolvedBy, item.resolvedByName);
  return `  ${attentionReference(item.id)}  ${compact(item.subject, SUBJECT_WIDTH)} · ${verb} by ${who} at ${item.resolvedAt}${answer}${note}`;
}

/** The resolution audit, newest first. */
export function renderAttentionHistory(snapshot: AttentionSnapshot): string {
  const warning = parseErrorWarning(snapshot);
  const preamble = warning === undefined ? [] : [warning];
  if (snapshot.resolved.length === 0) return [...preamble, 'No recorded resolutions.'].join('\n');
  const header = `Recent resolutions in ${snapshot.sessionId} — newest first`;
  return [...preamble, header, ...[...snapshot.resolved].sort(newestFirst).map(resolutionLine)].join('\n');
}

/** Confirmation for a mutation: what happened, and what is still waiting. */
export function renderAttentionMutation(
  verb: string,
  reference: string | undefined,
  snapshot: AttentionSnapshot,
): string {
  const subject = reference === undefined ? verb : `${verb} ${reference}`;
  return `${subject} — ${pluralItems(snapshot.count)} in ${snapshot.sessionId}`;
}

/** Confirmation for a direct notification. Zero devices is worth saying: the message went nowhere. */
export function renderNotification(delivered: number): string {
  const devices = delivered === 1 ? '1 device' : `${delivered} devices`;
  if (delivered === 0) return 'notification sent to 0 devices — no registered device wants this kind';
  return `notification sent to ${devices}`;
}
