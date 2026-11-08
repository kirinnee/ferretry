/**
 * The session observer's peers as a core test can have them: small, scripted stand-ins that answer what the real
 * peer answered for the scenarios the observer's own tests drive.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1). The observer reaches its peers through ports Ferrets owns
 * (`QuestionPolicy`, `PaneParsers`, `PaneFramesFactory`, `IncrementalTranscriptTailFactory`, `TranscriptSource`,
 * `TranscriptSendEvidenceFactory`, `PaneWorkSummarizer`); each stand-in here implements one of those ports and nothing
 * else. What the real peers do with a real harness's output is the owning plugin's to test, in its own suite — a
 * stand-in reads only the few record shapes and screens the observer's tests draw.
 */
import { readFile } from 'node:fs/promises';
import type { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import type { QuestionStepPolicy } from '../../../daemon/lib/session/observer/question.ts';
import type { PendingQuestion, SessionState } from '../../../daemon/lib/protocol/session.ts';
import type { ObservedRuntime } from '../../../daemon/lib/session/peers/harness-observation.ts';
import type {
  AnswerOperationRecord,
  AskedQuestion,
  QuestionDocument,
  StructuredQuestionProjection,
} from '../../../daemon/lib/session/peers/question.ts';
import type {
  SendEvidenceReading,
  TranscriptSendEvidence,
  TranscriptSendEvidenceFactory,
} from '../../../daemon/lib/session/peers/send.ts';
import type { PaneMetadata, PaneParsers, PaneState } from '../../../daemon/lib/session/peers/tmux.ts';
import type {
  IncrementalTranscriptTailFactory,
  ObservedHumanInput,
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptQuestion,
  TranscriptSource,
  TranscriptWindow,
} from '../../../daemon/lib/session/peers/transcript.ts';
import type { PaneFramesFactory, UsageLimit } from '../../../daemon/lib/session/peers/turn.ts';
import type { PaneProcess, PaneWorkSummarizer } from '../../../daemon/lib/session/peers/warden.ts';

// ── the question part (conversation) ────────────────────────────────────────────────────────────

const QUESTION_TOOL = 'AskUserQuestion';
const RELEASED_KIND = 'structured-answer-released-unconfirmed';
const UNCONFIRMED_KIND = 'structured-answer-unconfirmed';

const pendingOf = (event: Extract<TranscriptEvent, { kind: 'tool-call' }>): PendingQuestion => ({
  toolUseId: event.call.id,
  questions: (event.call.questions ?? []).map(question => ({
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    options: question.options.map(option => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  })),
  ...(event.timestamp === undefined ? {} : { askedAt: event.timestamp, lastSeenAt: event.timestamp }),
});

/** The open structured question in a tail: the last question call no tool result has answered. */
function projectQuestion(events: readonly TranscriptEvent[]): StructuredQuestionProjection {
  let pending: PendingQuestion | undefined;
  let resolved: string | undefined;
  for (const event of events) {
    if (event.kind === 'tool-call' && event.call.name === QUESTION_TOOL) {
      if ((event.call.questions ?? []).length === 0)
        return { kind: 'needs-human', reason: `unrecognized structured-question shape for tool ${event.call.id}` };
      pending = pendingOf(event);
    } else if (event.kind === 'tool-result' && pending?.toolUseId === event.result.callId) {
      resolved = pending.toolUseId;
      pending = undefined;
    }
  }
  if (pending !== undefined) return { kind: 'pending', question: pending };
  return resolved === undefined ? { kind: 'none' } : { kind: 'resolved', toolUseId: resolved };
}

const protectedStatus = (status: string | undefined): boolean =>
  status === 'completed' || status === 'stopped' || status === 'failed' || status === 'kill_failed';

/**
 * The document change a projection and the answer receipts imply — the rows of the conversation plugin's rule the
 * observer's scenarios reach: nothing recorded, a pending form, a confirmed receipt, an open receipt, a quarantine.
 */
function statePatch(
  current: QuestionDocument,
  projection: StructuredQuestionProjection,
  answerRecords: Iterable<AnswerOperationRecord> = [],
): Partial<SessionState> {
  const records = [...answerRecords];
  const projected =
    projection.kind === 'pending'
      ? projection.question.toolUseId
      : projection.kind === 'resolved'
        ? projection.toolUseId
        : undefined;
  const toolUseId = current.pendingQuestion?.toolUseId ?? projected;
  const matching = toolUseId === undefined ? [] : records.filter(record => record.toolUseId === toolUseId);
  const accepted = matching.find(record => record.outcome === 'accepted');
  const quarantined = matching.find(record => record.outcome === 'quarantined');
  const confirmed = matching.find(record => record.outcome === 'confirmed');
  const newer =
    projection.kind === 'pending' && projection.question.toolUseId !== toolUseId ? projection.question : undefined;
  const status = (open: SessionState['status']): SessionState['status'] =>
    protectedStatus(current.status) ? current.status : open;

  if (confirmed !== undefined || (accepted ?? quarantined) !== undefined) {
    if (current.lastAnsweredQuestionToolUseId === toolUseId && accepted === undefined) {
      if (current.pendingQuestion === undefined && current.needsHumanKind === undefined) return {};
      return {
        pendingQuestion: newer,
        lastAnsweredQuestionToolUseId: toolUseId,
        status: status(
          newer === undefined
            ? current.status === 'awaiting_question'
              ? 'running'
              : current.status
            : 'awaiting_question',
        ),
      };
    }
    if (accepted !== undefined) {
      if (current.pendingQuestion?.toolUseId === accepted.toolUseId && current.needsHumanKind === UNCONFIRMED_KIND)
        return {};
      const bound = current.pendingQuestion?.toolUseId === accepted.toolUseId ? current.pendingQuestion : undefined;
      return {
        pendingQuestion: bound,
        status: status(bound === undefined ? 'awaiting_user' : 'awaiting_question'),
        needsHumanKind: UNCONFIRMED_KIND,
        needsHuman: `answer request ${accepted.requestId} for ${accepted.toolUseId} may have reached the form, and release was not confirmed`,
      };
    }
    if (quarantined !== undefined)
      return {
        pendingQuestion: newer,
        status: status(newer === undefined ? 'awaiting_user' : 'awaiting_question'),
        needsHumanKind: RELEASED_KIND,
        needsHuman: `answer request ${quarantined.requestId} for ${quarantined.toolUseId} may have reached the form; the form was released, so prose may continue, but the original answer remains unconfirmed`,
      };
  }
  if (projection.kind === 'pending' && current.lastAnsweredQuestionToolUseId === projection.question.toolUseId)
    return {};
  if (projection.kind === 'pending')
    return { pendingQuestion: projection.question, status: status('awaiting_question') };
  if (projection.kind === 'needs-human')
    return {
      pendingQuestion: undefined,
      status: status('awaiting_user'),
      needsHumanKind: 'structured-question-unrecognized',
      reason: projection.reason,
    };
  return current.pendingQuestion === undefined && current.needsHumanKind !== 'structured-question-unrecognized'
    ? {}
    : {
        pendingQuestion: undefined,
        ...(current.needsHumanKind === 'structured-question-unrecognized' ? { needsHumanKind: undefined } : {}),
      };
}

/**
 * An accepted receipt settles when the observation proves its form advanced: `confirmed` when the document already
 * carries the answered tool id, `quarantined` (the keys may have landed, which answer is unknown) otherwise.
 */
function reconcile(
  records: ReadonlyMap<string, AnswerOperationRecord>,
  state: QuestionDocument,
  observation: { readonly activeToolUseId?: string | undefined; readonly resolvedToolUseId?: string | undefined } = {},
): {
  readonly records: ReadonlyMap<string, AnswerOperationRecord>;
  readonly settlements: readonly AnswerOperationRecord[];
} {
  const reconciled = new Map(records);
  const settlements: AnswerOperationRecord[] = [];
  for (const record of records.values()) {
    if (record.outcome !== 'accepted') continue;
    const confirmed = state.lastAnsweredQuestionToolUseId === record.toolUseId;
    const advanced =
      observation.resolvedToolUseId === record.toolUseId ||
      (observation.activeToolUseId !== undefined && observation.activeToolUseId !== record.toolUseId);
    if (!confirmed && !advanced) continue;
    const settlement: AnswerOperationRecord = {
      ...record,
      outcome: confirmed ? 'confirmed' : 'quarantined',
      reason: confirmed
        ? 'the answered form was already stamped durably; monitor reconciliation repaired the receipt'
        : `monitor evidence showed ${record.toolUseId} advanced without proving which answer landed; it was quarantined and was not sent again`,
    };
    reconciled.set(record.requestId, settlement);
    settlements.push(settlement);
  }
  return { records: reconciled, settlements };
}

/** The hook's record of a question as asked, laid at the end of the tail while the transcript still holds it back. */
function withAsked(events: readonly TranscriptEvent[], asked: AskedQuestion | undefined): readonly TranscriptEvent[] {
  if (asked === undefined) return events;
  const known = events.some(
    event =>
      (event.kind === 'tool-call' && event.call.id === asked.toolUseId) ||
      (event.kind === 'tool-result' && event.result.callId === asked.toolUseId),
  );
  if (known) return events;
  return [
    ...events,
    {
      kind: 'tool-call',
      harness: 'claude',
      role: 'assistant',
      call: { id: asked.toolUseId, name: QUESTION_TOOL, input: asked.input, questions: asked.questions },
    },
  ];
}

/** The model and effort the harness last stated in a settings record. */
function observedRuntime(events: readonly TranscriptEvent[]): ObservedRuntime {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind !== 'settings') continue;
    return {
      ...(event.settings.model === undefined ? {} : { model: event.settings.model }),
      ...(event.settings.reasoningEffort === undefined ? {} : { reasoningEffort: event.settings.reasoningEffort }),
      ...(event.timestamp === undefined ? {} : { at: event.timestamp }),
    };
  }
  return {};
}

function observedRuntimePatch(
  current: Pick<SessionState, 'observedModel' | 'observedModelAt' | 'observedReasoningEffort'>,
  observed: ObservedRuntime,
): Partial<SessionState> {
  if (observed.model === undefined) return {};
  if (current.observedModel === observed.model && current.observedReasoningEffort === observed.reasoningEffort)
    return {};
  return {
    observedModel: observed.model,
    ...(observed.at === undefined ? {} : { observedModelAt: observed.at }),
    ...(observed.reasoningEffort === undefined ? {} : { observedReasoningEffort: observed.reasoningEffort }),
  };
}

/** The question part as the conversation plugin answers it, for the scenarios the observer's tests draw. */
export const SCRIPTED_QUESTIONS: QuestionStepPolicy = Object.freeze<QuestionStepPolicy>({
  projectStructuredQuestion: projectQuestion,
  structuredQuestionStatePatch: statePatch,
  reconcileAnswerEvidence: reconcile,
  withAskedQuestion: withAsked,
  projectObservedContext: () => undefined,
  projectObservedRuntime: observedRuntime,
  observedRuntimeStatePatch: observedRuntimePatch,
});

// ── pane parsers and frames (terminals) ─────────────────────────────────────────────────────────

const INTERRUPT_HINTS = ['esc to interrupt', 'ctrl+c to interrupt'];
const CODEX_ELAPSED = /\bworking\s*\(\s*\d+[ms]/;
const CLAUDE_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\s*[·•∙]/;
const TOKEN_COUNTER = /[\d.,]+k?\s*tokens\s*[·•∙]/;
const SPINNER_PHRASE = /^[^\S\n]*[✻✳✶✽✢∗][^\n…]{1,120}…/mu;
const SPINNER_MARK = /^[^\S\n]*⏺\s*\S+…/mu;
const PROMPT = /^\s*[│|]?\s*[>›❯»](?:[\s ].*)?$/u;

function activeWork(pane: string): 'status' | 'spinner' | undefined {
  const lower = pane.toLowerCase();
  if (INTERRUPT_HINTS.some(marker => lower.includes(marker))) return 'status';
  if (CODEX_ELAPSED.test(lower) || CLAUDE_ELAPSED.test(lower) || TOKEN_COUNTER.test(lower)) return 'status';
  return SPINNER_PHRASE.test(pane) || SPINNER_MARK.test(pane) ? 'spinner' : undefined;
}

/** The questions both harnesses ask before a tool runs; only ever read together with a numbered choice list. */
const PERMISSION_QUESTIONS = ['do you want to', 'would you like to', 'allow command', 'approve this'];
const NUMBERED_CHOICE = /^\s*[│|]?\s*(?:[>›❯»▌]\s*)?[1-9][.)]\s+\S/u;
const PERMISSION_WINDOW_LINES = 25;

/**
 * Whether the bottom of the frame is a permission prompt: a permission question and at least two numbered choices
 * (the terminals plugin's `paneShowsPermissionPrompt`, as today's tmux module read it). The structured request is
 * not drawn — the observer's turn tests only need to know the harness is blocked on a choice.
 */
function scriptedPaneShowsPermissionPrompt(pane: string): boolean {
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-PERMISSION_WINDOW_LINES);
  if (lines.filter(line => NUMBERED_CHOICE.test(line)).length < 2) return false;
  const lower = lines.join('\n').toLowerCase();
  return PERMISSION_QUESTIONS.some(question => lower.includes(question));
}

/** The pane parsers as the terminals plugin reads the screens the observer's tests draw: work and a permission choice; no dialog. */
export const SCRIPTED_PANE_PARSERS: PaneParsers = Object.freeze<PaneParsers>({
  parsePermissionPrompt: () => undefined,
  paneActiveWork: activeWork,
  paneShowsPermissionPrompt: scriptedPaneShowsPermissionPrompt,
  paneBlockingPrompt: () => undefined,
  parseHarnessDialog: () => undefined,
});

const promptReady = (visible: string, metadata: PaneMetadata): boolean => {
  if (metadata.dead || activeWork(visible) !== undefined) return false;
  const lines = visible.split('\n');
  const row = metadata.cursorY;
  if (row !== undefined && row >= 0 && row < lines.length)
    return (metadata.cursorX === undefined || metadata.cursorX <= 2) && PROMPT.test(lines[row] as string);
  return lines.slice(-30).some(line => PROMPT.test(line));
};

const PANE_ACTIVITY_FORMAT =
  '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}|#{window_activity}|#{history_size}|#{pane_id} #{pane_pid}';

/**
 * A pane's frames read through its tmux client: one `display-message` for the metadata and the activity stamp
 * (`dead|exit|x|y|height|width|activity|history|id pid`), and one `capture-pane` for the screen — captured again only
 * when the stamp moved. A dead or missing pane answers nothing.
 */
export const SCRIPTED_PANE_FRAMES: PaneFramesFactory = port => {
  const frames = new Map<string, { readonly activity: string; readonly visible: string }>();
  return {
    state: async (tmuxSession): Promise<PaneState | undefined> => {
      const asked = await port.execute(['display-message', '-p', '-t', tmuxSession, PANE_ACTIVITY_FORMAT]);
      if (asked.code !== 0) {
        frames.delete(tmuxSession);
        return undefined;
      }
      const fields = asked.stdout.trimEnd().split('|');
      const number = (field: string | undefined): number | undefined =>
        field === undefined || field === '' || !Number.isFinite(Number(field)) ? undefined : Number(field);
      const metadata: PaneMetadata = {
        dead: fields[0] === '1',
        ...(number(fields[1]) === undefined ? {} : { exitCode: number(fields[1]) as number }),
        ...(number(fields[2]) === undefined ? {} : { cursorX: number(fields[2]) as number }),
        ...(number(fields[3]) === undefined ? {} : { cursorY: number(fields[3]) as number }),
        ...(number(fields[4]) === undefined ? {} : { height: number(fields[4]) as number }),
        ...(number(fields[5]) === undefined ? {} : { width: number(fields[5]) as number }),
      };
      if (metadata.dead) {
        frames.delete(tmuxSession);
        return undefined;
      }
      const activity = fields.slice(6).join('|');
      let visible = frames.get(tmuxSession)?.visible;
      if (frames.get(tmuxSession)?.activity !== activity) {
        const captured = await port.execute(['capture-pane', '-p', '-t', tmuxSession]);
        visible = captured.code === 0 ? captured.stdout : '';
        if (captured.code === 0) frames.set(tmuxSession, { activity, visible });
        else frames.delete(tmuxSession);
      }
      const screen = visible ?? '';
      return { alive: true, ...metadata, promptReady: promptReady(screen, metadata), history: '', visible: screen };
    },
    forget: tmuxSession => void frames.delete(tmuxSession),
  };
};

// ── the work under a pane (warden) ──────────────────────────────────────────────────────────────

/** A shell the pane or harness started is a tool command; the youngest is the one being waited on, keyed by its pid. */
export const SCRIPTED_PANE_WORK: PaneWorkSummarizer = (processes: readonly PaneProcess[]) => {
  const commands = processes.filter(
    process =>
      process.known === undefined &&
      /^-?(?:ba|z|da|k|fi)?sh$/u.test(process.argv.trim().split(/\s+/u)[0]?.split('/').at(-1) ?? ''),
  );
  const youngest = commands.at(-1);
  return {
    toolCommand: youngest !== undefined,
    ...(youngest === undefined ? {} : { commandKey: `pid:${youngest.pid}` }),
    leftoverBrowser: false,
  };
};

// ── the transcript (conversation) ───────────────────────────────────────────────────────────────

interface Record_ {
  readonly type?: string;
  readonly uuid?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly stop_reason?: string | null;
    readonly content?: unknown;
  };
}

const questionsOf = (input: unknown): readonly TranscriptQuestion[] => {
  const list = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  return list.map(raw => {
    const question = raw as {
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: { label: string; description?: string }[];
    };
    return {
      question: String(question.question ?? ''),
      ...(question.header === undefined ? {} : { header: question.header }),
      options: (question.options ?? []).map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      multiple: question.multiSelect === true,
    };
  });
};

/** One Claude record, as the events and the human input it carries. */
function claudeRecord(record: Record_): { events: TranscriptEvent[]; inputs: ObservedHumanInput[] } {
  const events: TranscriptEvent[] = [];
  const inputs: ObservedHumanInput[] = [];
  const base = {
    harness: 'claude' as const,
    ...(record.timestamp === undefined ? {} : { timestamp: record.timestamp }),
  };
  const content = record.message?.content;
  if (record.type === 'user') {
    if (typeof content === 'string') {
      events.push({ ...base, kind: 'message', role: 'user', text: content });
      inputs.push({
        harness: 'claude',
        text: content,
        proof: 'normal-user-record',
        observedAt: record.timestamp ?? '',
        proofKey: record.uuid ?? content,
        shapeVersion: 1,
      });
    } else if (Array.isArray(content))
      for (const block of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[])
        if (block.type === 'tool_result')
          events.push({
            ...base,
            kind: 'tool-result',
            role: 'tool',
            result: {
              callId: String(block.tool_use_id),
              content: block.content as never,
              isError: block.is_error === true,
            },
          });
  } else if (record.type === 'assistant' && Array.isArray(content)) {
    const stop = record.message?.stop_reason ?? undefined;
    for (const block of content as { type?: string; id?: string; name?: string; input?: unknown; text?: string }[]) {
      if (block.type === 'text')
        events.push({
          ...base,
          kind: 'message',
          role: 'assistant',
          text: block.text ?? '',
          ...(stop === undefined ? {} : { stopReason: stop }),
        });
      else if (block.type === 'tool_use') {
        const questions = block.name === QUESTION_TOOL ? questionsOf(block.input) : [];
        events.push({
          ...base,
          kind: 'tool-call',
          role: 'assistant',
          call: {
            id: String(block.id),
            name: String(block.name),
            input: block.input as never,
            ...(questions.length === 0 ? {} : { questions }),
          },
        });
      }
    }
    if (stop === 'end_turn') events.push({ ...base, kind: 'turn', role: 'system', state: 'completed' });
  }
  return { events, inputs };
}

/** One Codex record: a task boundary or a turn context naming the model. */
function codexRecord(record: { type?: string; timestamp?: string; payload?: Record<string, unknown> }): {
  events: TranscriptEvent[];
  inputs: ObservedHumanInput[];
} {
  const base = {
    harness: 'codex' as const,
    role: 'system' as const,
    ...(record.timestamp === undefined ? {} : { timestamp: record.timestamp }),
  };
  const payload = record.payload ?? {};
  if (record.type === 'event_msg' && payload.type === 'task_started')
    return { events: [{ ...base, kind: 'turn', state: 'started' }], inputs: [] };
  if (record.type === 'event_msg' && payload.type === 'task_complete')
    return { events: [{ ...base, kind: 'turn', state: 'completed' }], inputs: [] };
  if (record.type === 'turn_context')
    return {
      events: [
        {
          ...base,
          kind: 'settings',
          settings: {
            ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
            ...(typeof payload.effort === 'string' ? { reasoningEffort: payload.effort } : {}),
          },
        },
      ],
      inputs: [],
    };
  return { events: [], inputs: [] };
}

/** A harness transcript file read whole: JSON lines in the shape the harness writes, parsed for the scenarios drawn. */
async function readRecords(harness: TranscriptHarness, file: string) {
  const text = await readFile(file, 'utf8');
  const events: TranscriptEvent[] = [];
  const inputs: ObservedHumanInput[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const parsed = JSON.parse(raw) as Record_;
    const read = harness === 'claude' ? claudeRecord(parsed) : codexRecord(parsed as never);
    events.push(...read.events);
    inputs.push(...read.inputs);
  }
  return { events, inputs, size: Buffer.byteLength(text) };
}

const batchOf = (
  harness: TranscriptHarness,
  file: string,
  read: Awaited<ReturnType<typeof readRecords>>,
): TranscriptBatch => ({
  harness,
  file,
  reset: false,
  cursor: { byteOffset: read.size, pendingBytes: 0 },
  events: read.events,
  observedInputs: read.inputs,
  issues: [],
});

/** A transcript source over a harness's file: `read` is the whole file; a window hands it over in one step. */
export function scriptedTranscriptSource(harness: TranscriptHarness): TranscriptSource {
  return {
    harness,
    read: async file => batchOf(harness, file, await readRecords(harness, file)),
    follow: async function* (file) {
      yield batchOf(harness, file, await readRecords(harness, file));
    },
    window: (file): TranscriptWindow => {
      let done = false;
      return {
        file,
        next: async () => {
          if (done) return { more: false };
          done = true;
          return { batch: batchOf(harness, file, await readRecords(harness, file)), more: false };
        },
      };
    },
  };
}

/** The incremental tail over a source: the events of the file as it stands, read again on each call. */
export const SCRIPTED_TAIL: IncrementalTranscriptTailFactory = (source, file, sessionId, limit) => ({
  file,
  read: async () => (await source.read(file, { sessionId })).events.slice(-limit),
});

/** The question file Claude's hook wrote: a `PreToolUse` record for `AskUserQuestion` naming this transcript. */
export async function scriptedReadAskedQuestion(
  file: string,
  transcript: string | undefined,
): Promise<AskedQuestion | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== QUESTION_TOOL) return undefined;
  if (payload.transcript_path !== transcript || typeof payload.tool_use_id !== 'string') return undefined;
  const questions = questionsOf(payload.tool_input);
  if (questions.length === 0) return undefined;
  return { toolUseId: payload.tool_use_id, questions, input: payload.tool_input as never, askedAtMs: 0 };
}

/** The send tracker's evidence over one transcript: the human inputs its file holds, or nothing when no transcript is bound. */
export const SCRIPTED_SEND_EVIDENCE: TranscriptSendEvidenceFactory = (target, reader) => {
  const evidence: TranscriptSendEvidence = {
    read: async (id, since): Promise<SendEvidenceReading> => {
      const bound = await target(id);
      if (bound === undefined) return { readable: false, inputs: [] };
      const start = Number.isFinite(Date.parse(since))
        ? ({ at: 'since', instant: since } as const)
        : ({ at: 'beginning' } as const);
      const window = await reader.window(bound, start);
      if (window === undefined) return { readable: false, inputs: [] };
      const inputs: ObservedHumanInput[] = [];
      for (;;) {
        const step = await window.next();
        inputs.push(...(step.batch?.observedInputs ?? []));
        if (!step.more) break;
      }
      return { readable: true, inputs };
    },
  };
  return evidence;
};

// ── the limits the panes prove (usage) ──────────────────────────────────────────────────────────

/** The `storagePaneLimits` answer for a document pair: a `rate_limited` session whose dialog or quota names a limit. */
export async function scriptedPaneLimits(
  storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState'>,
  nowMs: number,
): Promise<ReadonlyMap<string, UsageLimit>> {
  const limits = new Map<string, UsageLimit>();
  for (const { id, status } of storage.listSessions()) {
    if (status !== 'rate_limited') continue;
    const [config, state] = await Promise.all([
      storage.readConfig(id).catch(() => undefined),
      storage.readState(id).catch(() => undefined),
    ]);
    const agent = (config as { agent?: unknown } | undefined)?.agent;
    const document = state as
      | {
          status?: string;
          quota?: { limitNotice?: string; retryAt?: number; unavailableReason?: string };
          harnessDialog?: { kind: string; title: string; body?: string };
        }
      | undefined;
    if (typeof agent !== 'string' || document?.status !== 'rate_limited') continue;
    const dialog = document.harnessDialog;
    const notice =
      dialog?.kind === 'usage-limit'
        ? dialog.body?.split('\n')[0]?.trim() || dialog.title
        : document.quota?.limitNotice;
    if (notice === undefined) continue;
    const retryAt = document.quota?.retryAt;
    if (retryAt !== undefined && retryAt <= nowMs) continue;
    limits.set(agent, {
      notice,
      spend: document.quota?.unavailableReason === 'spend_limit',
      ...(retryAt === undefined ? {} : { retryAt }),
    } as UsageLimit);
  }
  return limits;
}
