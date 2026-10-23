/**
 * The Pack mode commands a ferret runs in its shell, read for what they ARE (docs/pack-mode.md).
 *
 * A ferret starts a sub-ferret by running the CLI's `new` in its shell, asks which model suits a part with
 * `recommend`, and collects a result with `wait <id>`. Each is a raw tool call that reads as
 * `Bash · fy new --runtime … "<brief>"`; read here into what it asked for and what came of it, so the
 * transcript can show "Started sub-ferret :name" — the same way `peer-delivery.ts` shows a `send` as
 * "Sent to".
 *
 * WHAT IS READ. The command's own words (the runtime, model, effort and brief it asked for) and the CLI's
 * answer: the `--json` payload when the command asked for one (`PackNewOutcomeSchema`,
 * `PackRecommendationSchema`), else the human lines `packages/cli/src/lib/pack/render.ts` prints.
 *
 * DEGRADE DIRECTION. A command that is not one of these stays an ordinary tool call. One that is, but
 * whose answer this reader cannot make out, is still a card — it says what was ASKED and that the answer
 * was not recognised, never an outcome it did not see; "Show command" has the raw output.
 */

import {
  type PackAttempt,
  type PackNewOutcome,
  PackNewOutcomeSchema,
  type PackRecommendation,
  PackRecommendationSchema,
} from '@ferretry/protocol';
import { clientAt, shellCommandOf, simpleCommands, type Word } from './peer-delivery.ts';
import type { ToolCall, TranscriptEntry } from './session-screens.ts';

/** One candidate a start tried, in order. `probe` is milliseconds, or `cached` when no probe ran. */
export interface PackTry {
  readonly runtime: string;
  readonly model?: string;
  readonly outcome: 'started' | 'refused';
  readonly probe?: number | 'cached';
  readonly code?: string;
  readonly message?: string;
}

/** What a `new` answered. */
export type PackStartOutcome =
  | {
      readonly outcome: 'started';
      readonly id: string;
      /** Its callsign, when it has one. */
      readonly teammate?: string;
      readonly runtime: string;
      readonly model?: string;
      readonly effort?: string;
      /** Who picked the model, in the CLI's words: `you`, `the routing prompt` or `jev`. */
      readonly decidedBy: string;
      readonly note?: string;
      readonly attempts: readonly PackTry[];
    }
  | {
      readonly outcome: 'refused';
      readonly code: string;
      readonly message: string;
      readonly remedy?: string;
      readonly attempts: readonly PackTry[];
    };

/** What a `wait` collected. */
export interface PackWaitOutcome {
  readonly status: string;
  /** The ferret's `signal done` message, verbatim. */
  readonly summary?: string;
  /** The wait stopped the ferret once its result was collected. */
  readonly stopped: boolean;
  /** Anything else the wait said on its way out (a timeout, a ferret that needs a human). */
  readonly note?: string;
}

/** One model a recommendation lists as usable (or not) here now, in the order the daemon sorted them. */
export interface PackOption {
  readonly ready: boolean;
  /** Its label ("Claude Opus 5.5"). */
  readonly model: string;
  /** Its id, as `--model` takes it. */
  readonly id: string;
  readonly runtime: string;
  /** The effort the routing prompt names right after it. */
  readonly effort?: string;
  /** Where the routing prompt first names it: 1 for the first model it names. */
  readonly named?: number;
  /** The quota headroom in a phrase, left out when it was not measured. */
  readonly quota?: string;
  /** `code: message`, when it cannot run. */
  readonly refusal?: string;
}

export interface PackAdvice {
  /** The routing prompt in effect, whole. */
  readonly routing: string;
  /** Where it came from, in words ("your routing prompt", "the default, rendered from the model catalogs"). */
  readonly source?: string;
  readonly options: readonly PackOption[];
  /** The command that starts the first ready one. */
  readonly next?: string;
}

/**
 * Where a call got to: still running, failed outright (the command, not a refusal), answered in a way
 * this reader recognised, or answered in a way it did not.
 */
export type PackProgress<T> =
  | { readonly state: 'running' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'unread' }
  | { readonly state: 'done'; readonly value: T };

/** A `new` — a sub-ferret start — and what it asked for. */
export interface PackStartCall {
  readonly kind: 'new';
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly auto: boolean;
  /** Its task title, when one was given. */
  readonly name?: string;
  /** The brief; `null` when it came from a file or a shell expansion this reader did not run. */
  readonly brief: string | null;
  readonly briefFile?: string;
  readonly progress: PackProgress<PackStartOutcome>;
  /** A later `wait` for this ferret, folded into its card. */
  readonly collected?: PackProgress<PackWaitOutcome>;
  /** A later `new` was run after this one was refused: the ferret tried again. */
  readonly retried?: boolean;
}

/** A `wait` no card in view started. */
export interface PackWaitCall {
  readonly kind: 'wait';
  readonly id: string;
  readonly progress: PackProgress<PackWaitOutcome>;
}

/** A `recommend`: which models suit a part. */
export interface PackRecommendCall {
  readonly kind: 'recommend';
  readonly task: string | null;
  readonly progress: PackProgress<PackAdvice>;
}

export type PackCall = PackStartCall | PackWaitCall | PackRecommendCall;

// ── The command's words ─────────────────────────────────────────────────────────────────────────

/** The options of each verb that take a value, so the value is not read as the brief. */
const VALUE_OPTIONS: Readonly<Record<'new' | 'wait' | 'recommend', ReadonlySet<string>>> = {
  // `--use-case` is gone from the CLI, but an older ferret's transcript still carries it: its value is not the brief.
  new: new Set([
    '--runtime',
    '--model',
    '--effort',
    '--use-case',
    '--cwd',
    '--name',
    '--mode',
    '--prompt-file',
    '--since',
    '--harness',
  ]),
  wait: new Set(['--timeout', '--interval', '--until-marker']),
  recommend: new Set(['--use-case']),
};

interface Parsed {
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly words: readonly Word[];
}

/** A verb's options and positional words, `--name value` and `--name=value` alike. */
const parseArguments = (rest: readonly Word[], valued: ReadonlySet<string>): Parsed => {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const words: Word[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as Word;
    const equals = word.text.indexOf('=');
    if (word.text.startsWith('--') && equals > 2) options.set(word.text.slice(0, equals), word.text.slice(equals + 1));
    else if (valued.has(word.text)) {
      const value = rest[index + 1];
      if (value !== undefined) options.set(word.text, value.text);
      index += 1;
    } else if (word.text.startsWith('--')) flags.add(word.text);
    else words.push(word);
  }
  return { options, flags, words };
};

/** The positional words as one text, or `null` when any was a shell expansion this reader did not run. */
const typedText = (words: readonly Word[]): string | null =>
  words.some(word => word.expanded)
    ? null
    : words
        .map(word => word.text)
        .join(' ')
        .trim();

const option = (parsed: Parsed, name: string, field: string): Record<string, string> => {
  const value = parsed.options.get(name);
  return value === undefined ? {} : { [field]: value };
};

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

/** How Codex's exec tool reports a command's end. */
const CODEX_EXIT = /Process exited with code (\d+)/u;
/** How Claude's Bash tool reports a failing command. */
const CLAUDE_EXIT = /^Exit code (\d+)\n?/u;

interface Answer {
  readonly exit: number;
  readonly output: string;
}

/** The command's exit status and what it printed, without the harness's own header. */
const answerOf = (result: NonNullable<ToolCall['result']>): Answer => {
  const text = result.text ?? (typeof result.content === 'string' ? result.content : '');
  const codex = CODEX_EXIT.exec(text)?.[1];
  if (codex !== undefined) {
    const at = text.indexOf('Output:\n');
    return { exit: Number(codex), output: at === -1 ? '' : text.slice(at + 'Output:\n'.length) };
  }
  const claude = CLAUDE_EXIT.exec(text)?.[1];
  if (claude !== undefined) return { exit: Number(claude), output: text.replace(CLAUDE_EXIT, '') };
  return { exit: result.isError === true ? 1 : 0, output: text };
};

/** The first non-empty line, as a failure's reason in the CLI's own words. */
const firstLine = (output: string): string =>
  (
    output
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
  ).replace(/^error:\s*/iu, '');

/** The JSON object a `--json` command printed, or `undefined`. */
const jsonIn = (output: string): unknown => {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

const fromAttempt = (attempt: PackAttempt): PackTry => ({
  runtime: attempt.runtime,
  ...(attempt.model === undefined ? {} : { model: attempt.model }),
  outcome: attempt.outcome,
  ...(attempt.probe === undefined ? {} : { probe: attempt.probe === 'cached' ? 'cached' : (attempt.probeMs ?? 0) }),
  ...(attempt.refusal === undefined ? {} : { code: attempt.refusal.code, message: attempt.refusal.message }),
});

/** The words render.ts `renderPackNewOutcome` prints for who decided. */
const DECIDED_BY: Readonly<Record<Extract<PackNewOutcome, { outcome: 'started' }>['decidedBy'], string>> = {
  agent: 'you',
  routing: 'the routing prompt',
  jev: 'jev',
};

const fromOutcome = (outcome: PackNewOutcome): PackStartOutcome => {
  const attempts = outcome.attempts.map(fromAttempt);
  if (outcome.outcome === 'refused')
    return {
      outcome: 'refused',
      code: outcome.refusal.code,
      message: outcome.refusal.message,
      ...(outcome.refusal.remedy === undefined ? {} : { remedy: outcome.refusal.remedy }),
      attempts,
    };
  const { config } = outcome.view;
  return {
    outcome: 'started',
    id: config.id,
    ...(config.teammate === undefined ? {} : { teammate: config.teammate }),
    runtime: config.agent,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.launchReasoningEffort === undefined ? {} : { effort: config.launchReasoningEffort }),
    decidedBy: DECIDED_BY[outcome.decidedBy],
    ...(outcome.note === undefined ? {} : { note: outcome.note }),
    attempts,
  };
};

/** `  started <runtime> [<model>] [(probe OK 640 ms|probe OK, cached|probe OK)]` */
const STARTED_TRY = /^ {2}started (\S+)(?: ([^\s(]\S*))?(?: \(probe ([^)]*)\))?$/u;
/** `  refused <runtime> [<model>] [(probe failed 3436 ms|probe failed, shared)] — <code>: <message>` */
const REFUSED_TRY = /^ {2}refused (\S+)(?: ([^\s(]\S*))?(?: \(probe ([^)]*)\))? — ([a-z_]+): ?(.*)$/u;
/** `Started <teammate> (<id>) on <runtime>, <model> — decided by <you|the routing prompt|jev>.` */
const STARTED = /^Started (.+?) on (\S+?)(?:, (\S+))? — decided by (.+)\.$/u;

/** The milliseconds a probe took or `cached`; nothing when the line gave neither ("probe OK", "failed, shared"). */
const probeOf = (words: string | undefined): PackTry['probe'] => {
  const ms = /(\d+) ?ms/u.exec(words ?? '')?.[1];
  if (ms !== undefined) return Number(ms);
  return /cached/u.test(words ?? '') ? 'cached' : undefined;
};
/** `[fy new: ]refused (<code>): <message>` */
const REFUSED = /^(?:\S+ new: )?refused \(([a-z_]+)\): (.*)$/u;

const tryOf = (line: string): PackTry | undefined => {
  const started = STARTED_TRY.exec(line);
  const refused = started === null ? REFUSED_TRY.exec(line) : null;
  const match = started ?? refused;
  if (match === null) return undefined;
  const [, runtime, model, probeWords] = match;
  const probe = probeOf(probeWords);
  return {
    runtime: runtime as string,
    ...(model === undefined ? {} : { model }),
    outcome: started === null ? 'refused' : 'started',
    ...(probe === undefined ? {} : { probe }),
    ...(refused === null ? {} : { code: refused[4] as string, message: refused[5] as string }),
  };
};

/** `new`'s human lines (render.ts `renderPackNewOutcome`). */
const readStartLines = (output: string): PackStartOutcome | undefined => {
  const lines = output.split('\n');
  const attempts = lines.map(tryOf).filter((attempt): attempt is PackTry => attempt !== undefined);
  const at = lines.findIndex(line => STARTED.test(line) || REFUSED.test(line));
  const head = lines[at];
  if (head === undefined) return undefined;
  const refused = REFUSED.exec(head);
  if (refused !== null) {
    const remedy = lines[at + 1]?.trim();
    return {
      outcome: 'refused',
      code: refused[1] as string,
      message: refused[2] as string,
      ...(remedy === undefined || remedy === '' || remedy === 'Tried:' ? {} : { remedy }),
      attempts,
    };
  }
  const [, who, runtime, model, decidedBy] = STARTED.exec(head) as RegExpExecArray;
  const named = /^(.+) \((\S+)\)$/u.exec(who as string);
  const note = lines[at + 1];
  return {
    outcome: 'started',
    id: named === null ? (who as string) : (named[2] as string),
    ...(named === null ? {} : { teammate: named[1] as string }),
    runtime: runtime as string,
    ...(model === undefined ? {} : { model }),
    decidedBy: decidedBy as string,
    ...(note === undefined || note.trim() === '' || tryOf(note) !== undefined || note.startsWith('Wait for its result')
      ? {}
      : { note: note.trim() }),
    attempts,
  };
};

const readStart = (output: string, json: boolean): PackStartOutcome | undefined => {
  if (json) {
    const parsed = PackNewOutcomeSchema.safeParse(jsonIn(output));
    if (parsed.success) return fromOutcome(parsed.data);
  }
  return readStartLines(output);
};

/** `wait`'s answer: `<id> is <status>`, a blank line and the summary; or one line of JSON with `result`. */
const readWait = (output: string, json: boolean, clientName: string): PackWaitOutcome | undefined => {
  const lines = output.replace(/\n+$/u, '').split('\n');
  const own = (line: string): boolean => line.startsWith(`${clientName} wait: `);
  const said = lines.filter(own).map(line => line.slice(`${clientName} wait: `.length));
  const stopped = said.some(line => line.startsWith('stopped '));
  const other = said.filter(line => !line.startsWith('stopped '));
  const note = other.length === 0 ? {} : { note: other.join('\n') };
  const rest = lines.filter(line => !own(line));
  if (json) {
    const value = jsonIn(rest.join('\n'));
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record['status'] === 'string')
        return {
          status: record['status'],
          ...(typeof record['result'] === 'string' ? { summary: record['result'] } : {}),
          stopped,
          ...note,
        };
    }
  }
  const head = /^(\S+) is ([a-z_]+)$/u.exec(rest[0] ?? '');
  if (head === null) return undefined;
  const summary = rest.slice(1).join('\n').trim();
  return { status: head[2] as string, ...(summary === '' ? {} : { summary }), stopped, ...note };
};

/** The words render.ts `routingWords` prints for where the routing prompt came from. */
const sourceWords = (routing: PackRecommendation['routing']): string => {
  if (routing.source === 'default') return 'the default, rendered from the model catalogs';
  if (routing.suggested === undefined) return 'your routing prompt';
  return `cleaned up by ${routing.suggested.by} on ${routing.suggested.acceptedAt.slice(0, 10)} and accepted`;
};

const fromRecommendation = (recommendation: PackRecommendation): PackAdvice => ({
  routing: recommendation.routing.text,
  source: sourceWords(recommendation.routing),
  options: recommendation.available.map(
    (model): PackOption => ({
      ready: model.ready,
      model: model.modelLabel,
      id: model.model,
      runtime: model.runtime,
      ...(model.effort === undefined ? {} : { effort: model.effort }),
      ...(model.named === undefined ? {} : { named: model.named }),
      ...(model.quota.state === 'unknown' ? {} : { quota: model.quota.summary }),
      ...(model.refusal === undefined ? {} : { refusal: `${model.refusal.code}: ${model.refusal.message}` }),
    }),
  ),
  ...(recommendation.next === undefined ? {} : { next: recommendation.next }),
});

/** `Routing prompt (<where from>):` */
const ROUTING_HEAD = /^Routing prompt \((.+)\):$/u;
/** `Models usable here now (<n>):`, or the line that says there are none. */
const MODELS_HEAD = /^(?:Models usable here now \(\d+\):|No model can run here now\.)$/u;
/** `ready  <label> (<id>)[ at <effort>] · <runtime>[ · quota <summary>][ · named <n>th in the prompt]` */
const OPTION =
  /^(ready|cannot)\s+(.+?) \((\S+)\)(?: at (\S+))? · (\S+)(?: · quota (.+?))?(?: · named (\d+)(?:st|nd|rd|th) in the prompt)?$/u;

/**
 * `recommend`'s human lines (render.ts `renderPackRecommendation`).
 *
 * The OLD recommend ("Use case: …" and a numbered, ranked list) is deliberately not read: the use-case guide
 * it came from no longer exists, so an older transcript's card degrades to "not recognised — see the
 * command" rather than this reader keeping a second parser for a format nothing prints any more.
 */
const readAdviceLines = (output: string): PackAdvice | undefined => {
  const lines = output.split('\n');
  const source = ROUTING_HEAD.exec(lines[0] ?? '')?.[1];
  // The prompt is the owner's own text and may hold blank lines, so the models section is found from the end.
  const modelsAt = lines.findLastIndex(line => MODELS_HEAD.test(line));
  if (source === undefined || modelsAt === -1) return undefined;
  const routing = lines.slice(1, modelsAt).join('\n').trim();
  if (routing === '') return undefined;
  const options: PackOption[] = [];
  let next: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (index < modelsAt) continue;
    const start = /^Start the first: (.+)$/u.exec(line);
    if (start !== null) next = start[1];
    const match = OPTION.exec(line);
    if (match === null) continue;
    const [, ready, model, id, effort, runtime, quota, named] = match;
    // A model that cannot run says why on the indented line under it.
    const refusal =
      ready === 'cannot' && lines[index + 1]?.startsWith(' ') === true ? lines[index + 1]?.trim() : undefined;
    options.push({
      ready: ready === 'ready',
      model: model as string,
      id: id as string,
      runtime: runtime as string,
      ...(effort === undefined ? {} : { effort }),
      ...(named === undefined ? {} : { named: Number(named) }),
      ...(quota === undefined ? {} : { quota }),
      ...(refusal === undefined || refusal === '' ? {} : { refusal }),
    });
  }
  return { routing, source, options, ...(next === undefined ? {} : { next }) };
};

const readAdvice = (output: string, json: boolean): PackAdvice | undefined => {
  if (json) {
    const parsed = PackRecommendationSchema.safeParse(jsonIn(output));
    if (parsed.success) return fromRecommendation(parsed.data);
  }
  return readAdviceLines(output);
};

/**
 * Where a call got to. `read` makes out the answer; `answers` lists the exit statuses besides 0 that are
 * still an answer: a refused `new` exits 2 with its refusal printed, and a wait that ended without a
 * completion (1), that needs a human (3) or that timed out (124) still says how it ended.
 */
const progressOf = <T>(
  call: Pick<ToolCall, 'result'>,
  read: (output: string) => T | undefined,
  answers: readonly number[],
): PackProgress<T> => {
  if (call.result === undefined) return { state: 'running' };
  const answer = answerOf(call.result);
  const value = read(answer.output);
  if (value !== undefined && (answer.exit === 0 || answers.includes(answer.exit))) return { state: 'done', value };
  if (answer.exit !== 0) return { state: 'failed', reason: firstLine(answer.output) || `exit code ${answer.exit}` };
  return { state: 'unread' };
};

/**
 * The Pack command a tool call ran, or `null` when it is any other call.
 *
 * Only a command that IS one counts — `<client> new …` (not `--continue`, which adopts a conversation),
 * `<client> wait <id>` or `<client> recommend …`, possibly behind `cd …&&` or `direnv exec . `.
 */
export const readPackCall = (call: Pick<ToolCall, 'use' | 'result'>, clientName: string): PackCall | null => {
  const script = shellCommandOf(call);
  if (script === undefined || !script.includes(clientName)) return null;
  for (const words of simpleCommands(script)) {
    const start = clientAt(words, clientName);
    if (start === -1) continue;
    const verb = words[start + 1]?.text;
    if (verb !== 'new' && verb !== 'wait' && verb !== 'recommend') continue;
    const parsed = parseArguments(words.slice(start + 2), VALUE_OPTIONS[verb]);
    const json = parsed.flags.has('--json');
    if (verb === 'new') {
      if (parsed.flags.has('--continue')) continue;
      const brief = typedText(parsed.words);
      const briefFile = parsed.options.get('--prompt-file');
      return {
        kind: 'new',
        ...option(parsed, '--runtime', 'runtime'),
        ...option(parsed, '--model', 'model'),
        ...option(parsed, '--effort', 'effort'),
        auto: parsed.flags.has('--auto'),
        ...option(parsed, '--name', 'name'),
        brief: briefFile !== undefined && brief === '' ? null : brief,
        ...(briefFile === undefined ? {} : { briefFile }),
        progress: progressOf(call, output => readStart(output, json), [2]),
      };
    }
    if (verb === 'wait') {
      const id = parsed.words[0];
      if (id === undefined || id.expanded) continue;
      return {
        kind: 'wait',
        id: id.text,
        progress: progressOf(call, output => readWait(output, json, clientName), [1, 3, 124]),
      };
    }
    return {
      kind: 'recommend',
      task: typedText(parsed.words),
      progress: progressOf(call, output => readAdvice(output, json), []),
    };
  }
  return null;
};

// ── The transcript ──────────────────────────────────────────────────────────────────────────────

const LABEL: Readonly<Record<PackCall['kind'], string>> = {
  new: 'started a sub-ferret',
  wait: 'waited for a sub-ferret',
  recommend: 'asked which model suits',
};

/** The started ferret a `wait <id>` names, by id or by callsign. */
const waitsFor = (call: PackStartCall, id: string): boolean =>
  call.progress.state === 'done' &&
  call.progress.value.outcome === 'started' &&
  (call.progress.value.id === id || call.progress.value.teammate === id);

/**
 * The transcript with every Pack command lifted out of its tool group into a row of its own (`pack`),
 * between the calls that ran before and after it — as `projectDeliveries` does for a `send`.
 *
 * A `wait` for a ferret a card in this transcript started is folded INTO that card ("Result
 * collected") instead of standing alone, and its call joins the card's, so "Show command" still has it.
 * A refused start followed by another start is marked `retried`. Rows keep their ids: the first piece
 * of a split group keeps the group's.
 */
export const projectPackCalls = (
  entries: readonly TranscriptEntry[],
  clientName: string,
): readonly TranscriptEntry[] => {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.tools === undefined || entry.sent !== undefined) {
      out.push(entry);
      continue;
    }
    let run: ToolCall[] = [];
    let first = true;
    const flush = (): void => {
      if (run.length === 0) return;
      const id = first ? entry.id : `${entry.id}:${(run[0] as ToolCall).key}`;
      out.push({ ...entry, id, text: run.length === 1 ? 'ran a tool' : `ran ${run.length} tools`, tools: run });
      first = false;
      run = [];
    };
    for (const call of entry.tools) {
      const pack = readPackCall(call, clientName);
      if (pack === null) {
        run.push(call);
        continue;
      }
      flush();
      if (pack.kind === 'wait') {
        const card = out.findLastIndex(row => row.pack?.kind === 'new' && waitsFor(row.pack, pack.id));
        const row = out[card];
        if (row?.pack?.kind === 'new') {
          out[card] = { ...row, tools: [...(row.tools ?? []), call], pack: { ...row.pack, collected: pack.progress } };
          continue;
        }
      }
      if (pack.kind === 'new') {
        const earlier = out.findLastIndex(row => row.pack?.kind === 'new');
        const row = out[earlier];
        if (
          row?.pack?.kind === 'new' &&
          row.pack.progress.state === 'done' &&
          row.pack.progress.value.outcome === 'refused'
        )
          out[earlier] = { ...row, pack: { ...row.pack, retried: true } };
      }
      const at = call.ts === undefined ? Number.NaN : Date.parse(call.ts);
      out.push({
        id: `pack:${call.key}`,
        kind: 'tool',
        text: LABEL[pack.kind],
        tools: [call],
        pack,
        ...(Number.isFinite(at) ? { at } : {}),
      });
    }
    flush();
  }
  return out;
};
