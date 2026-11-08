import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type LogPageOptions,
  type QueuedMessage,
  splitTranscriptImageMarkers,
  type TranscriptImageMarker,
} from '../../contract/index.ts';
import { cancelSend, retrySend, submitSend } from './chat-reads.ts';
import type { FerretView } from '@ferretry/core-ferrets/contract';
import { projectDeliveries } from './peer-delivery.ts';
import { type TranscriptEntry } from './transcript-entries.ts';
import { parseSlashCommandText, type SlashCommand, withCommandOutput } from '../composer/slash-commands.ts';
import { classifySystemText } from './system-blocks.ts';
import { IMAGE_READ_TOOL, type ToolResultData, type ToolUseData } from './tool-extract.ts';
import {
  EMPTY_HISTORY,
  historyLog,
  historyMeetsTail,
  historyOffsets,
  joinLogs,
  type LogPage,
  oldestStart,
  type TranscriptHistory,
  type TranscriptHistoryStatus,
  withGap,
  withOlder,
  withTail,
} from './transcript-history.ts';
import { readUserMessage } from './user-message.ts';
import { fieldHash } from './session-chat-model.ts';

const LOG_HEADER = /^(?:\[(\d{2}:\d{2}:\d{2})\] )?(user|assistant|developer|system|tool)\/([a-z-]+):(?: (.*))?$/u;

interface LogRecord {
  readonly clock?: string;
  /** Where in the transcript the record came from, when the daemon said. */
  readonly offset?: number;
  readonly role: 'user' | 'assistant' | 'developer' | 'system' | 'tool';
  readonly kind: string;
  readonly lines: readonly string[];
}

const title = (value: string): string =>
  value
    .split('-')
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');

/** Who spoke. The record's time is not part of it: it becomes the row's own instant (`at`). */
const recordLabel = (record: LogRecord): string =>
  record.role === 'user'
    ? 'You'
    : record.role === 'assistant'
      ? record.kind === 'message'
        ? 'Assistant'
        : title(record.kind)
      : record.role === 'tool'
        ? `Tool · ${title(record.kind)}`
        : title(record.role);

const recordKind = (record: LogRecord): TranscriptEntry['kind'] => {
  if (record.role === 'user' && record.kind === 'message') return 'user';
  if (record.role === 'assistant' && record.kind === 'message') return 'assistant';
  return 'notice';
};

/** A tool call or its result — grouped into a run, never shown or hidden on its own. */
const isToolRecord = (record: LogRecord): boolean => record.kind === 'tool-call' || record.kind === 'tool-result';

/**
 * WHICH MACHINE RECORDS THE CONVERSATION LEAVES OUT. Reasoning, token usage, turn markers, settings
 * echoes and attachment stubs are bookkeeping, and the transcript shows none of them — there is no
 * "Show details" fold any more. An `error` is never bookkeeping: a failure that vanished would be a
 * bug, not tidiness.
 *
 * Dropping them HERE, before tool runs are grouped, is what keeps a run whole. Claude writes a usage
 * record after every assistant record, so a call and its result were always separated by one; a run
 * split there read as `2 tools · Bash, Edit` followed by `2 tools · result ×2`.
 */
const isHiddenRecord = (record: LogRecord): boolean =>
  !isToolRecord(record) && record.kind !== 'error' && !showsImages(record) && recordKind(record) === 'notice';

/**
 * Does this attachment line carry a picture the chat can draw? Only a line whose log names an image by
 * marker does: a daemon that writes none (an older one) leaves the line hidden, exactly as before.
 */
const attachmentImages = (record: LogRecord): ReturnType<typeof splitTranscriptImageMarkers>['images'] =>
  record.kind === 'attachment' && (record.role === 'user' || record.role === 'assistant')
    ? splitTranscriptImageMarkers(record.lines.join('\n')).images
    : [];

const showsImages = (record: LogRecord): boolean => attachmentImages(record).length > 0;

/** A picture a person or a ferret shared, as a row of its own: the log wrote it as its own record. */
const imageEntryFor = (record: LogRecord, id: string, at: number | undefined): TranscriptEntry => ({
  id,
  kind: record.role === 'user' ? 'user' : 'assistant',
  text: '',
  images: attachmentImages(record),
  ...(at === undefined ? {} : { at }),
});

const entryFor = (record: LogRecord, id: string, at: number | undefined): TranscriptEntry => {
  const text = record.lines.join('\n');
  return {
    id,
    kind: recordKind(record),
    text: text || title(record.kind),
    label: recordLabel(record),
    ...(at === undefined ? {} : { at }),
    ...(record.kind === 'error' ? { alert: true } : {}),
  };
};

/**
 * A person's message, another agent's, or Ferretry's own notice — the user channel carries all three.
 *
 * The id is taken from the record as written, so a row keeps its identity whatever this reading of it
 * decides. A peer or notice row is not labelled "You": who sent it is the row's own chrome, so it
 * carries no label, only the record's instant.
 *
 * Several ferret messages the daemon combined into ONE turn are one record but N rows, in order, each
 * from its own sender: the app draws what was said and by whom, never the combined wrapper.
 */
const userEntriesFor = (record: LogRecord, id: string, at: number | undefined): readonly TranscriptEntry[] => {
  const entry = entryFor(record, id, at);
  const message = readUserMessage(entry.text);
  if (message.kind !== 'combined') return [userEntryFor(entry, message, at)];
  const instant = at === undefined ? {} : { at };
  return message.parts.map(
    (part, position): TranscriptEntry => ({
      id: position === 0 ? entry.id : `${entry.id}~${position + 1}`,
      kind: 'user',
      text: part.body,
      peer: part.from,
      ...instant,
    }),
  );
};

const userEntryFor = (
  entry: TranscriptEntry,
  message: Exclude<ReturnType<typeof readUserMessage>, { readonly kind: 'combined' }>,
  at: number | undefined,
): TranscriptEntry => {
  const instant = at === undefined ? {} : { at };
  if (message.kind === 'human') {
    // Text the harness typed into the user channel — a background task finishing, an interrupt, a
    // reminder — is a quiet system row: never the reader's bubble, never a turn the reader opened.
    const event = classifySystemText(message.text);
    return event === null
      ? { ...entry, text: message.text }
      : { id: entry.id, kind: 'system', text: event.summary ?? event.label, event, ...instant };
  }
  if (message.kind === 'handoff') return { ...entry, text: message.text, handoff: message.pointer };
  return message.kind === 'notice'
    ? { id: entry.id, kind: 'system', text: message.text, ...instant }
    : { id: entry.id, kind: 'user', text: message.body, peer: message.from, ...instant };
};

/** `Read({"path":"src/App.tsx"})` — the daemon's rendering of one tool call. */
const TOOL_CALL = /^([^\s(]+)\(([\s\S]*)\)$/u;

const toolUse = (text: string): ToolUseData => {
  const match = TOOL_CALL.exec(text.trim());
  if (match === null) return { name: text.trim() || 'tool' };
  const raw = match[2] as string;
  try {
    return { name: match[1] as string, input: JSON.parse(raw) as unknown };
  } catch {
    return { name: match[1] as string, input: raw };
  }
};

/**
 * The daemon prefixes a failed result with `error `; there is no other marker on this wire. An image a
 * result carried arrives as a marker line under its text: those lines leave the text and become `images`.
 */
const toolResult = (raw: string): ToolResultData => {
  const { text, images } = splitTranscriptImageMarkers(raw);
  const seen = images.length === 0 ? {} : { images };
  return text.startsWith('error ') ? { text: text.slice('error '.length), isError: true, ...seen } : { text, ...seen };
};

const DAY_MS = 86_400_000;

/**
 * How far a record's clock may run AHEAD of the record after it and still be read as the same day.
 *
 * Records are not strictly in clock order. A message the agent was sent while it was busy is written
 * where the harness drained it — after the tool calls it waited behind — but carries the time it was
 * QUEUED, so the record before it can be a few seconds or minutes later. Read as midnight, that step
 * dated the message the reader had just sent, and everything above it, a whole day early: the row could
 * no longer be the send it was (`ledger-placement.ts` never lets an older row wear a newer send) and the
 * message was drawn twice. A browser clock a little behind the daemon's is the same step against `now`.
 *
 * An hour covers any wait behind one tool call; a real midnight between neighbours is a step back of
 * nearly a day, so only neighbours more than 23 hours apart are misread — next to the whole day the
 * walk already loses for neighbours more than 24 hours apart.
 */
const OUT_OF_ORDER_MS = 60 * 60_000;

/**
 * The instant of every record, oldest first; `undefined` for one with no clock.
 *
 * THE ONLY PLACE A UTC WALL CLOCK IS READ. The daemon prints each record's time as `HH:MM:SS` in UTC
 * and nothing else, so this turns that into a real instant once, and everything the reader sees is then
 * formatted from the instant on the reader's own clock (`message-clock.ts`) — never from the printed
 * text, which is why a phone in Tokyo no longer shows London's afternoon.
 *
 * The date is inferred by walking back from `now`: each record is the most recent instant its clock
 * names that is no more than {@link OUT_OF_ORDER_MS} after the record that follows it — a record a
 * little later than its successor was written out of clock order, not before a midnight. That dates a
 * long transcript correctly so long as no two neighbouring records are nearly a day apart. A record with
 * no clock gets no instant rather than a made-up one, because a wrong time is worse than none.
 */
const recordInstants = (records: readonly LogRecord[], now: number): readonly (number | undefined)[] => {
  const instants: (number | undefined)[] = [];
  let ceiling = now;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const clock = records[index]?.clock;
    if (clock === undefined) {
      instants[index] = undefined;
      continue;
    }
    const [hours, minutes, seconds] = clock.split(':').map(Number) as [number, number, number];
    const day = new Date(ceiling);
    const same = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes, seconds);
    const latest = ceiling + OUT_OF_ORDER_MS;
    // Its clock on the following record's day, or the day either side when that one is out of reach.
    ceiling = same > latest ? same - DAY_MS : same + DAY_MS <= latest ? same + DAY_MS : same;
    instants[index] = ceiling;
  }
  return instants;
};

interface ToolRun {
  /** Where the run's first record came from. */
  offset?: number;
  /** Where every record the run draws came from — its calls, results and their copies (`alsoAt`). */
  readonly anchors: number[];
  readonly calls: {
    key: string;
    use: ToolUseData;
    result?: ToolResultData;
    ts?: string;
    orphanResult?: boolean;
  }[];
}

/**
 * A run of consecutive tool calls and their results, as ONE row — the transcript's own collapsed
 * tool group, which reads as `4 tools · Read, Edit ×2, Bash` and opens to each call's input and
 * output. Results pair with the oldest call in the run still waiting for one; a result with no call
 * to pair with is kept as an orphan rather than dropped, because a row that silently vanished would
 * read as a tool that never ran.
 */
/** The places a row stands for besides where it begins, in order, once each. */
const otherAnchors = (anchors: readonly number[], offset: number | undefined): number[] =>
  [...new Set(anchors)].filter(anchor => anchor !== offset).sort((left, right) => left - right);

const toolEntry = (run: ToolRun): TranscriptEntry => {
  const alsoAt = otherAnchors(run.anchors, run.offset);
  return {
    // Named by the call that OPENED the run, so a run that grows is still the row the reader opened.
    id: `tools:${run.calls[0]?.key ?? ''}`,
    ...(run.offset === undefined ? {} : { offset: run.offset, ...(alsoAt.length === 0 ? {} : { alsoAt }) }),
    kind: 'tool',
    text: run.calls.length === 1 ? 'ran a tool' : `ran ${run.calls.length} tools`,
    tools: run.calls,
  };
};

/** A slash command as one compact row: `/model opus[1m] → Set model to …`. */
const commandEntry = (id: string, command: SlashCommand): TranscriptEntry => ({
  id,
  kind: 'command',
  text: [command.name, command.args, command.output].filter(Boolean).join(' '),
  command,
});

/**
 * A ROW'S NAME IS WHAT IT SAYS, NEVER WHERE IT SITS.
 *
 * The daemon answers with the newest events of a session, not all of them (`DEFAULT_LOG_TAIL`), so in
 * any session long enough to matter each new event pushes the oldest one out and every record moves
 * up one place. A name built from that place renamed every row on every read, and React rebuilt the
 * whole transcript: an interactive page lost its state, an open tool group closed, a menu went with
 * its row. So a record is named by its own content — clock, speaker, kind and text — and the rare
 * exact repeat inside one window by how many came before it.
 */
const recordIds = (): ((signature: string) => string) => {
  const seen = new Map<string, number>();
  return signature => {
    const base = `log:${fieldHash(signature)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  };
};

/** Whether the next record that shows anything is another picture. */
const followedByImages = (records: readonly LogRecord[], index: number, skipped: ReadonlySet<number>): boolean => {
  for (let next = index + 1; next < records.length; next += 1) {
    const record = records[next];
    if (record === undefined || isHiddenRecord(record) || skipped.has(next)) continue;
    return showsImages(record);
  }
  return false;
};

/** Adds pictures to the run's image read, opening it when the run has none yet. */
const addImageRead = (run: ToolRun, images: readonly TranscriptImageMarker[], key: string): void => {
  const index = run.calls.findIndex(call => call.use.name === IMAGE_READ_TOOL);
  const existing = index === -1 ? [] : (run.calls[index]?.result?.images ?? []);
  const all = [...existing, ...images];
  const call = {
    key: index === -1 ? key : (run.calls[index]?.key ?? key),
    use: { name: IMAGE_READ_TOOL, input: { count: all.length } },
    result: { images: all },
  };
  if (index === -1) run.calls.push(call);
  else run.calls[index] = call;
};

/** Claude's framing around a message it surfaced mid-turn, before and after the message itself. */
const MID_TURN_LEAD = 'The user sent a new message while you were working:';
const MID_TURN_TRAILER = 'This is how Claude Code surfaces messages the user sends mid-turn';

/** Whitespace-insensitive, case-sensitive: the same rule the ledger matches a send's words by. */
const normalized = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

/**
 * The same words with each picture named only by its type. A marker's handle names the record it was read
 * from, so a copy's picture and its twin's never share one — which is why this is trusted only for a result
 * whose CALL was already proved a copy of the twin's call: the same invocation, read twice.
 */
const withoutImageHandles = (value: string): string =>
  normalized(value).replace(/\[fy-image \S+ (\S+)\]/gu, '[fy-image $1]');

/** The words a mid-turn copy carries: the message itself, with Claude's framing lifted off. */
const framedWords = (record: LogRecord): string | undefined => {
  if (record.clock !== undefined || record.role !== 'user' || record.kind !== 'message') return undefined;
  const text = record.lines.join('\n');
  if (!text.startsWith(MID_TURN_LEAD)) return undefined;
  const body = text.slice(MID_TURN_LEAD.length);
  const trailer = body.lastIndexOf(MID_TURN_TRAILER);
  return normalized(trailer === -1 ? body : body.slice(0, trailer));
};

const isTurnRecord = (record: LogRecord): boolean => record.role === 'system' && record.kind === 'turn';

/** Where a mid-turn copy's search stops: the agent speaking again, or a turn starting or ending. */
const endsSegment = (record: LogRecord): boolean =>
  (record.role === 'assistant' && record.kind === 'message') || isTurnRecord(record);

const wordsOf = (record: LogRecord): string => normalized(record.lines.join('\n'));

/** The next timed record that shows, from `from` on; none past an untimed record or a turn record. */
const nextReal = (records: readonly LogRecord[], from: number): number | undefined => {
  for (let index = from; index < records.length; index += 1) {
    const record = records[index] as LogRecord;
    if (isTurnRecord(record)) return undefined;
    if (isHiddenRecord(record)) continue;
    if (record.clock === undefined) return undefined;
    return index;
  }
  return undefined;
};

/**
 * How many calls are still waiting for a result where record `at` sits. The tool run it is in is read
 * back to where it began, then FORWARD as the chat pairs it: each result answers the oldest waiting call,
 * and a result with no call waiting (its call fell outside the loaded page) answers nothing. Records
 * already found to be copies are left out.
 */
const pendingCalls = (records: readonly LogRecord[], at: number, copies: ReadonlySet<number>): number => {
  let start = at;
  for (let index = at - 1; index >= 0; index -= 1) {
    const record = records[index] as LogRecord;
    if (copies.has(index) || isHiddenRecord(record)) continue;
    if (!isToolRecord(record)) break;
    start = index;
  }
  let waiting = 0;
  for (let index = start; index < at; index += 1) {
    const record = records[index] as LogRecord;
    if (copies.has(index) || isHiddenRecord(record)) continue;
    if (record.kind === 'tool-call') waiting += 1;
    else if (waiting > 0) waiting -= 1;
  }
  return waiting;
};

/**
 * Do a copy and the record it may copy say the same thing? The same words; or, for a tool's result, the
 * same words with each picture named by its type, when it is provably the same invocation: its call lined
 * up as a copy too, or exactly ONE call is waiting and no other call sits between the two results — a call
 * has one result, so a second answer to that one call can only be a copy of the first.
 */
const sameWords = (
  records: readonly LogRecord[],
  copy: number,
  twin: number,
  callLinedUp: boolean,
  copies: ReadonlySet<number>,
): boolean => {
  const copied = records[copy] as LogRecord;
  const real = records[twin] as LogRecord;
  if (wordsOf(copied) === wordsOf(real)) return true;
  if (copied.kind !== 'tool-result') return false;
  if (withoutImageHandles(copied.lines.join('\n')) !== withoutImageHandles(real.lines.join('\n'))) return false;
  if (callLinedUp) return true;
  for (let between = copy + 1; between < twin; between += 1)
    if ((records[between] as LogRecord).kind === 'tool-call') return false;
  return pendingCalls(records, copy, copies) === 1;
};

/** The records that are only copies, and the row a twin's search position starts at when its copy sits right before it. */
interface Copies {
  readonly copies: ReadonlySet<number>;
  readonly startsAt: ReadonlyMap<number, number>;
  /** Where each twin's copies came from, so a search hit on a copy still finds the row the twin draws. */
  readonly copiedAt: ReadonlyMap<number, readonly number[]>;
}

/**
 * WHICH RECORDS ARE ONLY A COPY OF A LATER ONE, so a message — or a tool's call and result — is drawn once.
 *
 * Claude Code (seen on 2.1.317) writes a copy of what it is given — a message, a tool's result, sometimes
 * the call with it — with NO time, straight before the real records; a message that arrives mid-turn is
 * copied inside "The user sent a new message while you were working: …" instead. The daemon passes both
 * on, so the chat drew a bare bubble with no time or ticks above the real, ticked one, and a tool run read
 * "Bash, result": the copy's result answered the call and the real one was left over.
 *
 * A COPY LINES UP WITH WHAT IT COPIES. A run of untimed records copies the timed records straight after
 * it, IN ORDER: each untimed record is tried against the next timed record not yet matched, and folds into
 * it only with the same role, kind and words; one that does not match stays, and the next is tried against
 * the same record. Bookkeeping between them is skipped, but nothing crosses a turn record. A picture in a
 * tool's result is compared by its type only for the same invocation (`sameWords`).
 *
 * A MID-TURN COPY is found by its framing, which only Claude writes: it folds into the next timed message
 * with the same words before the agent next speaks or the turn changes.
 *
 * Every pairing is ONE-TO-ONE. Sending "ok" twice on purpose is two copies and two real records, so each
 * copy folds into its own real record and both messages stay. A timed record is never folded, and an
 * untimed one that lines up with nothing is kept: nothing is hidden on the strength of a copy that is not
 * there. A copy sitting right before its twin hands the twin its position in the file, so a search hit on
 * either record lands on the one row they draw.
 */
const copyRecords = (records: readonly LogRecord[]): Copies => {
  const copies = new Set<number>();
  const taken = new Set<number>();
  const twins = new Map<number, number>();
  const pair = (copy: number, twin: number): void => {
    copies.add(copy);
    taken.add(twin);
    twins.set(copy, twin);
  };

  // A run of plain copies against the timed records straight after it.
  let index = 0;
  while (index < records.length) {
    const first = records[index] as LogRecord;
    if (first.clock !== undefined || isHiddenRecord(first) || framedWords(first) !== undefined) {
      index += 1;
      continue;
    }
    const run: number[] = [];
    let next = index;
    for (; next < records.length; next += 1) {
      const record = records[next] as LogRecord;
      if (isTurnRecord(record) || (record.clock !== undefined && !isHiddenRecord(record))) break;
      if (!isHiddenRecord(record) && framedWords(record) === undefined) run.push(next);
    }
    let twin = nextReal(records, next);
    let previousCallLinedUp = false;
    for (const member of run) {
      if (twin === undefined) break;
      const copy = records[member] as LogRecord;
      const real = records[twin] as LogRecord;
      if (
        copy.role !== real.role ||
        copy.kind !== real.kind ||
        !sameWords(records, member, twin, previousCallLinedUp, copies)
      ) {
        // Not this record's copy: it stays, and the next copy is tried against the same record.
        previousCallLinedUp = false;
        continue;
      }
      pair(member, twin);
      previousCallLinedUp = copy.kind === 'tool-call';
      twin = nextReal(records, twin + 1);
    }
    index = next;
  }

  // Mid-turn copies, by their framing.
  records.forEach((record, index) => {
    const words = framedWords(record);
    if (words === undefined) return;
    for (let next = index + 1; next < records.length; next += 1) {
      const later = records[next] as LogRecord;
      if (endsSegment(later)) return;
      if (later.clock === undefined || taken.has(next) || later.role !== 'user' || later.kind !== 'message') continue;
      if (wordsOf(later) !== words) continue;
      pair(index, next);
      return;
    }
  });

  const startsAt = new Map<number, number>();
  for (const [copy, twin] of twins) {
    const offset = records[copy]?.offset;
    if (offset === undefined) continue;
    let adjacent = true;
    for (let between = copy + 1; between < twin && adjacent; between += 1) {
      const record = records[between] as LogRecord;
      adjacent = isHiddenRecord(record) || copies.has(between);
    }
    if (adjacent) startsAt.set(twin, Math.min(offset, startsAt.get(twin) ?? offset));
  }
  const copiedAt = new Map<number, number[]>();
  for (const [copy, twin] of twins) {
    const offset = records[copy]?.offset;
    if (offset !== undefined) copiedAt.set(twin, [...(copiedAt.get(twin) ?? []), offset]);
  }
  return { copies, startsAt, copiedAt };
};

const projectRecords = (records: readonly LogRecord[], now: number): readonly TranscriptEntry[] => {
  const instants = recordInstants(records, now);
  const { copies, startsAt, copiedAt } = copyRecords(records);
  const idFor = recordIds();
  /** The record being projected: a row it opens starts where its copy did, when one sat right before it. */
  let current = -1;
  const offsetOf = (record: LogRecord): number | undefined => startsAt.get(current) ?? record.offset;
  /** Every place in the file the current record's row stands for: the record itself and its copies. */
  const anchorsOf = (record: LogRecord): number[] => [
    ...(record.offset === undefined ? [] : [record.offset]),
    ...(copiedAt.get(current) ?? []),
  ];
  const entries: TranscriptEntry[] = [];
  let run: ToolRun | null = null;
  const flush = (): void => {
    if (run !== null) entries.push(toolEntry(run));
    run = null;
  };
  // Every row a record opens carries where the record came from, so a search hit can find its row.
  const push = (entry: TranscriptEntry, record: LogRecord): void => {
    const offset = offsetOf(record);
    const alsoAt = otherAnchors(anchorsOf(record), offset);
    entries.push(offset === undefined ? entry : { ...entry, offset, ...(alsoAt.length === 0 ? {} : { alsoAt }) });
  };
  const open = (record: LogRecord): ToolRun => {
    const offset = offsetOf(record);
    return { calls: [], anchors: [], ...(offset === undefined ? {} : { offset }) };
  };
  records.forEach((record, index) => {
    // A copy is left out like bookkeeping: it is not a row, and it does not end a tool run.
    if (isHiddenRecord(record) || copies.has(index)) return;
    current = index;
    const text = record.lines.join('\n');
    if (isToolRecord(record)) {
      run ??= open(record);
      run.anchors.push(...anchorsOf(record));
      const key = idFor(`${record.clock ?? ''}|${record.kind}|${text}`);
      if (record.kind === 'tool-call') {
        const at = instants[index];
        run.calls.push({ key, use: toolUse(text), ...(at === undefined ? {} : { ts: new Date(at).toISOString() }) });
        return;
      }
      const waiting = run.calls.find(call => call.result === undefined && call.orphanResult !== true);
      if (waiting === undefined)
        run.calls.push({ key, use: { name: 'result' }, result: toolResult(text), orphanResult: true });
      else waiting.result = toolResult(text);
      return;
    }
    if (showsImages(record)) {
      // Pictures read one after another are ONE `Read N images` call in the tool run, not a card each.
      if (run !== null || followedByImages(records, index, copies)) {
        run ??= open(record);
        run.anchors.push(...anchorsOf(record));
        addImageRead(
          run,
          attachmentImages(record),
          idFor(`${record.clock ?? ''}|${record.role}|${record.kind}|${text}`),
        );
        return;
      }
      flush();
      push(
        imageEntryFor(record, idFor(`${record.clock ?? ''}|${record.role}|${record.kind}|${text}`), instants[index]),
        record,
      );
      return;
    }
    const command = recordKind(record) === 'user' ? parseSlashCommandText(text) : null;
    // The caveat is an instruction to the model, never something anybody said, so it is dropped
    // outright — and, like bookkeeping, it does not end a tool run.
    if (command?.kind === 'caveat') return;
    flush();
    const id = idFor(`${record.clock ?? ''}|${record.role}|${record.kind}|${text}`);
    if (command?.kind === 'command') {
      push(commandEntry(id, command.command), record);
      return;
    }
    if (command?.kind === 'output') {
      // Claude writes a command's output as its own record straight after the command. It joins
      // that row; output whose command fell outside the loaded window still gets a row of its own.
      const last = entries.at(-1);
      if (last?.command !== undefined && last.command.output === undefined && last.command.tone === 'ok') {
        entries[entries.length - 1] = commandEntry(last.id, withCommandOutput(last.command, command));
        return;
      }
      push(commandEntry(id, withCommandOutput({ name: '', tone: 'ok' }, command)), record);
      return;
    }
    const at = instants[index];
    if (recordKind(record) === 'user') for (const entry of userEntriesFor(record, id, at)) push(entry, record);
    else push(entryFor(record, id, at), record);
  });
  flush();
  return entries;
};

/**
 * Projects the daemon's proved, normalized `logs` tail into the already-ported
 * transcript component. The wire format is deliberately parsed rather than
 * guessed from harness JSON: `OperatorReadService.renderTranscript` is the
 * compatibility contract this first workspace slice consumes. The daemon's
 * paged event route is mounted, but structured history/live-event projection
 * remains an explicit integration gap.
 *
 * Text before the first record header is not a record at all; like every other piece of daemon
 * bookkeeping it is left out of the conversation. `now` dates the records' wall clocks, and `clientName` is
 * the CLI a ferret runs to message another (`peer-delivery.ts`).
 */
export const transcriptEntriesFromLog = (
  text: string,
  now: number = Date.now(),
  clientName = 'fy',
  /** One byte offset per record header in `text`, in order (`SessionLogPage.offsets`). */
  offsets?: readonly number[],
): readonly TranscriptEntry[] => {
  if (text.trim() === '') return [];
  const records: LogRecord[] = [];
  let current: { clock?: string; offset?: number; role: LogRecord['role']; kind: string; lines: string[] } | null =
    null;

  const flush = (): void => {
    if (current === null) return;
    records.push(current);
    current = null;
  };

  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const match = LOG_HEADER.exec(line);
    if (match !== null) {
      flush();
      const offset = offsets?.[records.length];
      current = {
        ...(match[1] === undefined ? {} : { clock: match[1] }),
        ...(offset === undefined ? {} : { offset }),
        role: match[2] as LogRecord['role'],
        kind: match[3] ?? 'message',
        lines: [match[4] ?? ''],
      };
    } else if (current !== null) {
      current.lines.push(line.startsWith('    ') ? line.slice(4) : line);
    }
  }
  flush();

  // A ferret's Pack commands live in the tool calls of these entries; a `conversation.row` panel gets only their shell
  // commands as `tools` (row-slots.tsx).
  return projectDeliveries(projectRecords(records, now), clientName);
};

/** What the refresh reads, bound to one daemon's client (`chat-reads.ts`). */
export interface ChatReadApi {
  /** The ferret's view (`GET /v1/ferrets/:ferretId`). */
  readonly get: (id: string) => Promise<FerretView>;
  /** One page of the transcript: the tail, or the page `before` a byte (`GET …/log-page`). */
  readonly logPage: (id: string, options?: LogPageOptions) => Promise<LogPage>;
  /** The ferret's send ledger. Optional: a reader that does not show sends never asks. */
  readonly sends?: (id: string) => Promise<readonly unknown[]>;
  /** The ferret's durable queue. Optional. */
  readonly queue?: (id: string) => Promise<readonly QueuedMessage[]>;
}

export interface ChatRefreshEnvironment {
  readonly visible: () => boolean;
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly onVisibility: (callback: () => void) => () => void;
  /** The clock a relaxed poll measures its spacing on. Absent: the poll is never relaxed. */
  readonly now?: () => number;
  /** For {@link ChatRefreshControl.nudge}'s settle window. Absent: a nudge reads at once. */
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * The poll's spacing while nothing can change unannounced: the live feed is up and the agent is idle
 * at its prompt. Every journal append — a send, a turn starting, a question — arrives on the feed and
 * {@link ChatRefreshControl.nudge}s a read, so the three-second poll in that state only
 * re-read an unchanged transcript, session, ledger and board: four relay round trips every three
 * seconds for a page nobody is typing into. The slow poll stays as the safety net under the feed, for
 * what the journal cannot say (a transcript row written with no turn change). The feed proves itself
 * alive every thirty seconds, so a dead one is noticed long before this poll would have to cover for it.
 */
export const RELAXED_REFRESH_MS = 120_000;

/**
 * How long a nudge waits for the rest of its burst. A turn ending journals several events within a few
 * milliseconds, and each used to queue a full read of its own (four requests) behind the one before.
 * One read after the burst has settled sees all of it.
 */
export const NUDGE_SETTLE_MS = 150;

/**
 * How long after the reader acts — a send, an answer — the poll keeps its full rate whatever the feed
 * says. The relaxed poll trusts the feed to announce the turn the action starts; a feed that died without
 * a close is only noticed after three silent windows, and until then a relaxed page sat on its last read
 * for up to {@link RELAXED_REFRESH_MS}: the sent message with its tick, no "Working…", no reply. Inside
 * this window such a feed costs one ordinary poll instead, and the read that sees the turn working keeps
 * the poll at full rate for the rest of it.
 */
export const ACTED_WATCH_MS = 30_000;

/**
 * The slowest the durable queue goes unread while the page polls at all. A queue change is announced on the feed
 * (`control.queue_changed`, journalled after the change is on disk) and read on that nudge, so this beat exists for
 * the announcement that never arrives — a feed that dropped between the change and its delivery. It is slow on
 * purpose: one extra read of one bounded window every half minute, not the three-second read it replaced.
 */
export const QUEUE_FALLBACK_MS = 30_000;

/** A failed queue read is tried again after this long, doubling each failure up to {@link QUEUE_FALLBACK_MS}. */
const QUEUE_RETRY_MS = 3_000;

export interface ChatRefreshInput {
  readonly api: ChatReadApi;
  readonly ferretId: string;
  readonly intervalMs?: number;
  readonly environment: ChatRefreshEnvironment;
  readonly onTranscript: (entries: readonly TranscriptEntry[]) => void;
  /**
   * Every good read's raw TAIL text, before it is parsed: what the session cache keeps for the next
   * open. Older pages the reader scrolled up through are not kept — the next open starts at the tail.
   */
  readonly onLog?: (text: string) => void;
  /** What the top of the chat offers, whenever it changes (`lib/transcript-history.ts`). */
  readonly onHistory?: (status: TranscriptHistoryStatus) => void;
  readonly onSession: (view: FerretView) => void;
  /** Every refresh's send ledger, when the api reads one. A failed read keeps the previous rows. */
  readonly onSends?: (sends: readonly unknown[]) => void;
  /**
   * A ledger read that failed, in the failure's own words — an outage included, because the rows it
   * leaves on screen go on claiming a fate nobody is reading any more (`markLedgerUnread`).
   */
  readonly onSendsFailed?: (reason: string) => void;
  /** Every refresh's durable queue. A failed read keeps the previous messages: the queue is an overlay too. */
  readonly onQueue?: (messages: readonly QueuedMessage[]) => void;
  readonly onError: (message: string | null) => void;
  /**
   * Whether the daemon refused the transcript because it can prove no file is this session's own —
   * said apart from any other failure, because its remedy is a restart rather than a wait.
   */
  readonly onTranscriptUnbound?: (unbound: boolean) => void;
  /**
   * Failures somebody else already says — a lost carrier, which the connection model reports once and
   * retries on its own. A quiet failure neither sets the message nor clears it, and leaves the last good
   * transcript where it is: the screen goes stale, not blank. Absent means every failure is said here.
   */
  readonly quiet?: (reason: unknown) => boolean;
  /**
   * Whether nothing can change without the live feed saying so (the feed is up and the agent is idle),
   * asked on every poll tick. While it answers `true` the poll reads at most every
   * {@link RELAXED_REFRESH_MS}. Absent: always the full rate.
   */
  readonly relaxed?: () => boolean;
}

export interface ChatRefreshControl {
  readonly initial: Promise<void>;
  /** `afterCurrent` is for a write that needs evidence newer than any poll
   * already in flight. Timer/visibility reads leave it false and still
   * coalesce onto the current request. */
  readonly refresh: (afterCurrent?: boolean) => Promise<void>;
  /**
   * Something changed (a live event): read once the burst settles, and after any read in flight.
   * Every nudge inside one {@link NUDGE_SETTLE_MS} window is the same read.
   */
  readonly nudge: () => void;
  /**
   * The reader has something open that acts on the durable queue (a queued message's menu or editor): while at least one
   * is, the poll reads the queue on every tick again. Reads one at once. Returns the release; calling it twice is safe.
   * Without a watcher the queue is read only on a nudge, an explicit refresh or the first read — never on a bare tick.
   */
  readonly watchQueue: () => () => void;
  /**
   * The reader just acted, so something is about to change: the poll is not relaxed for
   * {@link ACTED_WATCH_MS} from now, whatever {@link ChatRefreshInput.relaxed} answers.
   */
  readonly acted: () => void;
  /**
   * Read the page of history just older than the oldest one on screen and put it in front. One at a
   * time: a call while one is loading is the same load. Nothing to do at the start of the conversation,
   * or on a daemon that cannot page.
   */
  readonly loadOlder: () => Promise<void>;
  /**
   * Load older pages until the chat reaches back to `offset` of the transcript file `file` (a search
   * hit's place); `false` when it cannot (`chat-search-model.ts`).
   */
  readonly loadUntil: (offset: number, file: string) => Promise<boolean>;
  /** The transcript file token the chat's pages came from, once one has been read. */
  readonly file: () => string | undefined;
  readonly stop: () => void;
}

/** A jump to a search hit reads older pages this big, and at most this many of them. */
const JUMP_PAGE_LIMIT = 2_000;
const JUMP_PAGES = 100;

/** How many events one gap read may hold, and how many reads may fill one gap before the history restarts. */
const GAP_PAGE_LIMIT = 2_000;
const GAP_ROUNDS = 4;

/** A refusal with this HTTP status and code, read off whatever error class carried it. */
const refusedWith = (reason: unknown, status: number, code: string): boolean =>
  typeof reason === 'object' &&
  reason !== null &&
  (reason as { readonly status?: unknown }).status === status &&
  (reason as { readonly code?: unknown }).code === code;

const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** The daemon's `no_transcript` refusal: no transcript it can prove is this session's own. */
const isTranscriptUnbound = (reason: unknown): boolean =>
  typeof reason === 'object' && reason !== null && (reason as { readonly code?: unknown }).code === 'no_transcript';

/**
 * Keeps one daemon/session workspace fresh without a watch loop in React.
 * Reads are skipped while the document is hidden, coalesced while in flight,
 * and fenced after teardown so a re-pair or route change cannot paint a late
 * answer into the next workspace.
 */
export const startChatRefresh = (input: ChatRefreshInput): ChatRefreshControl => {
  let stopped = false;
  let inflight: Promise<void> | null = null;
  const environment = input.environment;
  /** When the last read started, on {@link ChatRefreshEnvironment.now}'s clock. */
  let lastReadAt = Number.NEGATIVE_INFINITY;
  /** When the reader last acted, on the same clock. */
  let actedAt = Number.NEGATIVE_INFINITY;
  let settle: unknown;
  /** The pages on screen. Only the tail is read on a poll; the reader's scrolling adds the rest. */
  let history: TranscriptHistory = EMPTY_HISTORY;
  let older: 'idle' | 'loading' | 'error' = 'idle';
  let olderLoad: Promise<void> | null = null;
  let said: TranscriptHistoryStatus | undefined;

  const historyStatus = (): TranscriptHistoryStatus => {
    if (history.tail === null) return 'unavailable';
    if (older !== 'idle') return older;
    return oldestStart(history) === 0 ? 'start' : 'more';
  };
  const sayHistory = (): void => {
    const status = historyStatus();
    if (status === said) return;
    said = status;
    input.onHistory?.(status);
  };

  /** `[from, before)` of the transcript in as many reads as it takes, or nothing if it will not come whole. */
  const readGap = async (
    logPage: ChatReadApi['logPage'],
    from: number,
    before: number,
    file: string,
  ): Promise<LogPage | undefined> => {
    let log = '';
    let offsets: readonly number[] | undefined = [];
    let end = before;
    for (let round = 0; round < GAP_ROUNDS; round += 1) {
      const page = await logPage(input.ferretId, { before: end, from, limit: GAP_PAGE_LIMIT, file });
      log = joinLogs(page.log, log);
      offsets = page.offsets === undefined || offsets === undefined ? undefined : [...page.offsets, ...offsets];
      if (page.start <= from)
        return { log, start: page.start, file: page.file, ...(offsets === undefined ? {} : { offsets }) };
      end = page.start;
    }
    return undefined;
  };

  /**
   * The tail the cache keeps, having joined it to the held history. The history is rendered from `history` as it
   * stands when the whole refresh lands, so an older page that arrived meanwhile is not painted over.
   */
  const readTranscript = async (): Promise<{ readonly tail: string }> => {
    const logPage = input.api.logPage;
    const tail = await logPage(input.ferretId);
    const outcome = withTail(history, tail);
    if (outcome.kind === 'applied') history = outcome.history;
    else {
      const gap = await readGap(logPage, outcome.from, outcome.before, outcome.file).catch(() => undefined);
      history = gap === undefined ? { ...EMPTY_HISTORY, tail } : withGap(history, gap, tail);
    }
    return { tail: tail.log };
  };

  /** The whole history as rows: its log, each line placed where the daemon said it came from. */
  const historyEntries = (): readonly TranscriptEntry[] =>
    transcriptEntriesFromLog(historyLog(history), undefined, undefined, historyOffsets(history));

  const loadOlder = (limit?: number): Promise<void> => {
    const logPage = input.api.logPage;
    const before = oldestStart(history);
    const file = history.tail?.file;
    if (olderLoad !== null) return olderLoad;
    if (stopped || before === null || before === 0 || file === undefined) return Promise.resolve();
    older = 'loading';
    sayHistory();
    olderLoad = logPage(input.ferretId, { before, file, ...(limit === undefined ? {} : { limit }) })
      .then(
        page => {
          if (stopped) return;
          history = withOlder(history, page, before);
          older = 'idle';
          // The tail moved while the page was in flight: the next read fills between them, then shows both.
          if (historyMeetsTail(history)) input.onTranscript(historyEntries());
          else void refresh(true);
        },
        (reason: unknown) => {
          if (stopped) return;
          older = 'idle';
          // The session's transcript is another file now: what was held names nothing in it.
          if (refusedWith(reason, 409, 'log_cursor_stale') || refusedWith(reason, 409, 'message_cursor_stale')) {
            history = EMPTY_HISTORY;
            void refresh(true);
          } else older = 'error';
        },
      )
      .finally(() => {
        olderLoad = null;
        if (!stopped) sayHistory();
      });
    return olderLoad;
  };

  /**
   * Older pages, in large steps, until the history reaches back to `offset` of the file `file` — where a
   * search hit is. `false` when it could not: another file, a failed page, a daemon that cannot page, or
   * a hit further back than {@link JUMP_PAGES} pages of {@link JUMP_PAGE_LIMIT} events.
   */
  const loadUntil = async (offset: number, file: string): Promise<boolean> => {
    for (let round = 0; ; round += 1) {
      const oldest = oldestStart(history);
      if (oldest === null || history.tail?.file !== file) return false;
      if (oldest <= offset) return true;
      if (round === JUMP_PAGES) return false;
      await loadOlder(JUMP_PAGE_LIMIT);
      if (older === 'error' || oldestStart(history) === oldest) return false;
    }
  };

  /** Whether the next read asks the machine for the durable queue; a bare poll tick does not unless someone watches it. */
  let queueWatchers = 0;
  /** When the queue was last read well, and how many reads in a row have failed since (and when the next may start). */
  let queueReadAt: number | undefined;
  let queueFailures = 0;
  let queueRetryAt = 0;

  /**
   * Whether a bare poll tick should read the queue too: someone is acting on it, or its last read failed and the
   * backoff has run out, or the slow beat ({@link QUEUE_FALLBACK_MS}) says it has gone unread too long. Without a
   * clock only the first two can be told, so a failed read is retried on every tick and nothing else is.
   */
  const queueDue = (): boolean => {
    if (queueWatchers > 0) return true;
    const now = environment.now?.();
    if (now === undefined) return queueFailures > 0;
    if (queueFailures > 0) return now >= queueRetryAt;
    return queueReadAt === undefined || now - queueReadAt >= QUEUE_FALLBACK_MS;
  };

  const read = (afterCurrent: boolean, withQueue: boolean): Promise<void> => {
    if (stopped || !environment.visible()) return Promise.resolve();
    if (inflight !== null) return afterCurrent ? inflight.then(() => read(false, withQueue)) : inflight;

    lastReadAt = environment.now?.() ?? lastReadAt;
    inflight = Promise.allSettled([
      readTranscript(),
      input.api.get(input.ferretId),
      // A daemon that cannot answer the ledger still shows its transcript: the sends are an overlay.
      input.api.sends?.(input.ferretId) ?? Promise.resolve(undefined),
      // Read on the same beat as the ledger; the queue is an overlay too, so its failure never blanks the chat.
      withQueue ? (input.api.queue?.(input.ferretId) ?? Promise.resolve(undefined)) : Promise.resolve(undefined),
    ])
      .then(([logs, session, sends, queue]) => {
        if (stopped) return;
        if (queue.status === 'fulfilled' && queue.value !== undefined) {
          input.onQueue?.(queue.value);
          queueReadAt = environment.now?.() ?? queueReadAt;
          queueFailures = 0;
        } else if (queue.status === 'rejected') {
          queueFailures += 1;
          queueRetryAt =
            (environment.now?.() ?? 0) + Math.min(QUEUE_RETRY_MS * 2 ** (queueFailures - 1), QUEUE_FALLBACK_MS);
        }
        if (sends.status === 'fulfilled' && sends.value !== undefined) input.onSends?.(sends.value);
        if (sends.status === 'rejected') input.onSendsFailed?.(errorMessage(sends.reason));
        const errors: string[] = [];
        const quiet = input.quiet ?? (() => false);
        let silenced = false;
        if (logs.status === 'fulfilled') {
          input.onLog?.(logs.value.tail);
          input.onTranscript(historyEntries());
          sayHistory();
        } else if (quiet(logs.reason)) silenced = true;
        else errors.push(`Transcript: ${errorMessage(logs.reason)}`);
        if (!silenced) input.onTranscriptUnbound?.(logs.status === 'rejected' && isTranscriptUnbound(logs.reason));

        if (session.status === 'fulfilled') {
          if (session.value.config.id === input.ferretId) input.onSession(session.value);
          else errors.push('Session: daemon returned another session');
        } else if (quiet(session.reason)) silenced = true;
        else errors.push(`Session: ${errorMessage(session.reason)}`);
        // Nothing to say but an outage said elsewhere: the message stays exactly as it was.
        if (errors.length === 0 && silenced) return;
        input.onError(errors.length === 0 ? null : errors.join(' · '));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  /** Every read a caller asks for — a send, a nudge, the page coming back — includes the queue. */
  const refresh = (afterCurrent = false): Promise<void> => read(afterCurrent, true);

  /**
   * A poll tick), skipped while relaxed and the last read is younger than {@link RELAXED_REFRESH_MS} —
   * unless the reader acted within {@link ACTED_WATCH_MS}.
   */
  const tick = (): void => {
    const now = environment.now?.();
    if (
      now !== undefined &&
      input.relaxed?.() === true &&
      queueFailures === 0 &&
      now - actedAt >= ACTED_WATCH_MS &&
      now - lastReadAt < RELAXED_REFRESH_MS
    )
      return;
    void read(false, queueDue());
  };

  const watchQueue = (): (() => void) => {
    queueWatchers += 1;
    void read(false, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      queueWatchers -= 1;
    };
  };

  const nudge = (): void => {
    if (stopped) return;
    if (environment.setTimeout === undefined) {
      void refresh(true);
      return;
    }
    if (settle !== undefined) return;
    settle = environment.setTimeout(() => {
      settle = undefined;
      void refresh(true);
    }, NUDGE_SETTLE_MS);
  };

  const interval = environment.setInterval(tick, Math.max(1_000, input.intervalMs ?? 3_000));
  const stopVisibility = environment.onVisibility(() => void refresh());
  const initial = refresh();

  const acted = (): void => {
    actedAt = environment.now?.() ?? actedAt;
  };

  return {
    initial,
    refresh,
    nudge,
    watchQueue,
    acted,
    loadOlder: () => loadOlder(),
    loadUntil,
    file: () => history.tail?.file,
    stop: () => {
      if (stopped) return;
      stopped = true;
      environment.clearInterval(interval);
      if (settle !== undefined) environment.clearTimeout?.(settle);
      settle = undefined;
      stopVisibility();
    },
  };
};

/**
 * What a queued message's menu or editor calls when it opens, bound to the page's refresh control: the poll reads the
 * queue on every tick until the returned release is called. The control is read AT THE CALL, because it is replaced
 * when the session changes; with none (nothing is polling yet) there is nothing to hold and the release does nothing.
 */
export const queueWatcher =
  (control: { readonly current: Pick<ChatRefreshControl, 'watchQueue'> | null | undefined }) => (): (() => void) =>
    control.current?.watchQueue() ?? (() => undefined);

/**
 * A ledger row's Retry, bound to one ferret: re-sends under the send's ORIGINAL id — which the daemon
 * types again only when it proved the message absent, or when the reader chose "send again anyway"
 * on an unconfirmed one — then asks for fresh evidence so the row moves at once.
 */
export const sendRetrier =
  (
    client: Pick<PluginClient, 'call'> | null,
    ferretId: string,
    refresh: () => void,
  ): ((record: { readonly sendId: string }, force: boolean) => Promise<boolean>) =>
  async (record, force) => {
    if (client === null) return false;
    await retrySend(client, ferretId, record.sendId, force);
    refresh();
    return true;
  };

/**
 * A ledger row's Cancel, bound to one ferret: takes the send back (erasing it from the agent's composer
 * when it is sitting typed there), then asks for fresh evidence so the row moves at once. The daemon's
 * refusal reaches the caller as a rejection carrying its own sentence.
 */
export const sendCanceller =
  (
    client: Pick<PluginClient, 'call'> | null,
    ferretId: string,
    refresh: () => void,
  ): ((record: { readonly sendId: string }) => Promise<boolean>) =>
  async record => {
    if (client === null) return false;
    await cancelSend(client, ferretId, record.sendId);
    refresh();
    return true;
  };

/**
 * A ledger row's Press Enter, bound to one ferret: presses Enter ONCE for a send sitting typed in the
 * agent's composer, then asks for fresh evidence. The daemon refuses unless the composer holds exactly
 * that message.
 */
export const sendSubmitter =
  (
    client: Pick<PluginClient, 'call'> | null,
    ferretId: string,
    refresh: () => void,
  ): ((record: { readonly sendId: string }) => Promise<boolean>) =>
  async record => {
    if (client === null) return false;
    await submitSend(client, ferretId, record.sendId);
    refresh();
    return true;
  };
