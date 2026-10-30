/**
 * What model a session is ACTUALLY running, taken from the harness's own record of itself.
 *
 * The evidence was already being parsed and then dropped: the Claude parser reads the model off every
 * assistant turn's usage record, the Codex parser emits a `settings` event carrying the model and the
 * reasoning level it applied — and nothing wrote either into the session. So every surface that asks
 * "which model is this" had exactly one thing left to show, the model the session was LAUNCHED with,
 * which is a request rather than an observation and is wrong the moment anyone switches.
 *
 * TWO RULES, AND THEY ARE THE WHOLE MODULE.
 *
 *   * A CONFIGURED MODEL IS NEVER OBSERVED TRUTH. Nothing here reads the session configuration. An
 *     absent observation stays absent, and the surfaces above decide for themselves what to say
 *     about not knowing — which is why the composer says `model unavailable` rather than confidently
 *     naming a model nobody has seen run.
 *   * THE HARNESS'S STRING IS RECORDED VERBATIM. Claude's output strips the context-window selector
 *     (`[1m]`) that the configured name retains, so the observed and configured strings can name one
 *     model and not be equal. That disagreement is a REAL fact about the two sources and it is
 *     handover #28's subject; normalising it here would decide #28 by accident, in the one place that
 *     is supposed to report what was seen. `contextWindowForSession` already consumes both strings
 *     knowing they differ.
 */

import type { SessionState } from '@ferretry/protocol';
import { isIsoInstant } from '../../iso-instant.ts';
import type { TranscriptEvent } from '../../transcript/types.ts';

/** The harness-observed runtime, as the transcript last stated it. */
export interface ObservedRuntime {
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Whether fast mode is on, as the harness last stated it. */
  readonly fast?: boolean;
  /** The timestamp of the newest record that carried any of these. */
  readonly at?: string;
  /** How large the conversation last was, as the harness's own newest usage record stated it. */
  readonly context?: ObservedContext;
}

/** The context size the transcript last stated: a token count, when it was written, and a window if the harness named one. */
export interface ObservedContext {
  readonly tokens: number;
  readonly at: string;
  /** The window the harness itself reported (Codex does); never derived here. */
  readonly window?: number;
}

/** A non-blank string, trimmed; blank is no evidence at all. */
function stated(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A transcript timestamp only when it is the instant the session document declares.
 *
 * A harness is free to stamp its records however it likes, and this value lands in a field the
 * protocol types as an offset-bearing ISO instant. Writing an unparseable one would make the whole
 * session document fail to read — the observation would take the session down with it.
 */
function instant(value: string | undefined): string | undefined {
  const candidate = stated(value);
  return candidate !== undefined && isIsoInstant(candidate) ? candidate : undefined;
}

/**
 * The model a Claude `/model <id>` command asked for, read off the record Claude Code writes when the
 * command is typed into its prompt (`<command-name>/model</command-name>` beside
 * `<command-args>claude-opus-5-5</command-args>`). Undefined for any other record, and for a bare
 * `/model` — that opens the picker, and the choice made there is printed only as a display name
 * (`Opus 5.5 (1M context)`) that no model id can be recovered from.
 */
function claudeModelCommand(event: TranscriptEvent): string | undefined {
  if (event.harness !== 'claude' || event.kind !== 'message' || event.role !== 'user') return undefined;
  if (!/<command-name>\s*\/model\s*<\/command-name>/u.test(event.text)) return undefined;
  return stated(/<command-args>([^<]*)<\/command-args>/u.exec(event.text)?.[1]);
}

/**
 * Claude Code's printed answer to a local command — the record it writes right after one — as whether
 * it confirmed a `/model`: `Set model to …`, or `Kept model as …` for re-selecting the running model.
 * Undefined for a record that is not a printed answer at all.
 */
function claudeModelConfirmed(event: TranscriptEvent): boolean | undefined {
  if (event.harness !== 'claude' || event.kind !== 'message' || event.role !== 'user') return undefined;
  const printed = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/u.exec(event.text);
  if (printed === null) return undefined;
  return printed[1] === 'stdout' && /^\s*(?:Set model to|Kept model as)\b/u.test(printed[2] ?? '');
}

/**
 * Whether a Codex service tier is the fast one. Only the two tiers `/fast` moves between say anything:
 * `priority` is fast and `default` is not. Another tier (`ultrafast`, `flex`) is neither, so it is no
 * evidence about fast mode rather than a claim that it is off.
 */
const codexTierIsFast = (tier: string | undefined): boolean | undefined =>
  tier === 'priority' ? true : tier === 'default' ? false : undefined;

/** SGR colour sequences, which Claude wraps its `↯` glyph in when it prints a local command's answer. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what introduces the styling being removed.
const ANSI_STYLE = /\x1b\[[0-9;]*m/gu;

/**
 * Whether Claude Code's printed answer to a local command states fast mode. `/fast on` answers
 * `↯ Fast mode ON · $8/$40 per Mtok`, `/fast off` answers `Fast mode OFF`, and a `/model` switch to a
 * model with no fast mode ends `… · Fast mode OFF` — so the statement is read off the answer itself,
 * not off the command that preceded it. A refusal (`Fast mode unavailable: …`) says neither word and
 * is no evidence; stderr is never evidence.
 */
function claudeFastStated(event: TranscriptEvent): boolean | undefined {
  if (event.harness !== 'claude' || event.kind !== 'message' || event.role !== 'user') return undefined;
  const printed = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/u.exec(event.text);
  if (printed === null) return undefined;
  const answer = /(?:^|[\s·↯])Fast mode (ON|OFF)\b/u.exec((printed[1] ?? '').replace(ANSI_STYLE, ''));
  return answer === null ? undefined : answer[1] === 'ON';
}

/**
 * The runtime evidence ONE event carries, given the `/model` command still awaiting its answer.
 *
 * A CLAUDE SWITCH IS CONFIRMED BY ITS OWN ANSWER, NOT BY THE NEXT TURN. Claude restates its model
 * only on an assistant turn's usage record, so a `/model` typed at an idle prompt — which is exactly
 * how the daemon switches a Claude session — left no evidence until somebody sent a message, and the
 * composer said "switching…" for as long as nobody did. The command and its answer are two records,
 * so the id is the one the command NAMED, taken only once Claude has printed that it took it. A
 * refused command, or a bare `/model` whose picker choice is printed only as a display name, is no
 * evidence at all. The next assistant turn then restates the model in the API's own spelling.
 */
function eventEvidence(
  event: TranscriptEvent,
  requested: string | undefined,
): { readonly model?: string; readonly effort?: string; readonly fast?: boolean } | undefined {
  if (event.kind === 'settings') {
    const fast = codexTierIsFast(stated(event.settings.serviceTier));
    return {
      model: stated(event.settings.model),
      effort: stated(event.settings.reasoningEffort),
      ...(fast === undefined ? {} : { fast }),
    };
  }
  if (event.kind === 'usage') return { model: stated(event.usage.model) };
  const fast = claudeFastStated(event);
  if (fast !== undefined) return { fast };
  return requested !== undefined && claudeModelConfirmed(event) === true ? { model: requested } : undefined;
}

/**
 * HOW LARGE THE CONVERSATION LAST WAS: the newest usage record that states a context size, or the size a
 * compaction boundary says it left behind when that is newer — a usage record from before a compaction
 * would otherwise keep the ring red for a session that just emptied itself.
 *
 * A record with no usable timestamp is no evidence: an older record's count is not this one's, and the
 * stored field is typed as an instant. The window is carried separately because only some harnesses
 * state one, and a later record that omits it does not retract it.
 */
export function projectObservedContext(events: readonly TranscriptEvent[]): ObservedContext | undefined {
  let tokens: number | undefined;
  let at: string | undefined;
  let window: number | undefined;
  for (const event of events) {
    const stamp = instant(event.timestamp);
    if (stamp === undefined) continue;
    if (event.kind === 'usage' && event.usage.contextTokens !== undefined) {
      tokens = event.usage.contextTokens;
      at = stamp;
      window = event.usage.contextWindow ?? window;
    } else if (event.kind === 'compaction' && event.tokensAfter !== undefined) {
      tokens = event.tokensAfter;
      at = stamp;
    }
  }
  return tokens === undefined || at === undefined
    ? undefined
    : { tokens, at, ...(window === undefined ? {} : { window }) };
}

/**
 * Fold a transcript tail into the runtime it last showed.
 *
 * LAST EVIDENCE WINS, per field. A Codex settings record may state a level without restating the
 * model, so the two are carried independently rather than replaced as a pair — replacing them
 * together would erase a known model the moment the harness reported only a level.
 */
export function projectObservedRuntime(events: readonly TranscriptEvent[]): ObservedRuntime {
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let fast: boolean | undefined;
  let at: string | undefined;
  // The `/model <id>` still waiting for Claude's printed answer. Any answer settles it, taken or not.
  let requested: string | undefined;
  for (const event of events) {
    const observed = eventEvidence(event, requested);
    if (claudeModelConfirmed(event) !== undefined) requested = undefined;
    requested = claudeModelCommand(event) ?? requested;
    if (
      observed === undefined ||
      (observed.model === undefined && observed.effort === undefined && observed.fast === undefined)
    )
      continue;
    if (observed.model !== undefined) model = observed.model;
    if (observed.effort !== undefined) reasoningEffort = observed.effort;
    if (observed.fast !== undefined) fast = observed.fast;
    at = instant(event.timestamp) ?? at;
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(fast === undefined ? {} : { fast }),
    ...(at === undefined ? {} : { at }),
  };
}

/**
 * The state patch this observation implies, or nothing at all.
 *
 * EMPTY WHEN THERE IS NOTHING NEW, so a read does not rewrite the session document every time
 * somebody opens it. `observedModelAt` moves when the newest evidence does — which is what lets a
 * caller tell a fresh confirmation of the same model from the stale one it already had, and is why
 * re-selecting the model a session is already on still settles instead of hanging.
 *
 * NOTHING IS EVER CLEARED. An absent observation means the tail this was folded from carried no
 * evidence — a transcript that has been rotated, or a tail short enough to miss the last settings
 * record — and forgetting a model the harness genuinely reported would make the composer flicker
 * back to `model unavailable` on a session that is running perfectly well.
 */
export function observedRuntimeStatePatch(
  current: Pick<
    SessionState,
    | 'observedModel'
    | 'observedModelAt'
    | 'observedReasoningEffort'
    | 'observedFast'
    | 'contextTokens'
    | 'contextAt'
    | 'contextWindow'
  >,
  observed: ObservedRuntime,
): Partial<SessionState> {
  const model = observed.model ?? current.observedModel;
  const reasoningEffort = observed.reasoningEffort ?? current.observedReasoningEffort;
  const fast = observed.fast ?? current.observedFast;
  const at = observed.at ?? current.observedModelAt;
  const contextTokens = observed.context?.tokens ?? current.contextTokens;
  const contextAt = observed.context?.at ?? current.contextAt;
  const contextWindow = observed.context?.window ?? current.contextWindow;
  if (
    model === current.observedModel &&
    reasoningEffort === current.observedReasoningEffort &&
    fast === current.observedFast &&
    at === current.observedModelAt &&
    contextTokens === current.contextTokens &&
    contextAt === current.contextAt &&
    contextWindow === current.contextWindow
  )
    return {};
  return {
    ...(model === undefined ? {} : { observedModel: model }),
    ...(reasoningEffort === undefined ? {} : { observedReasoningEffort: reasoningEffort }),
    ...(fast === undefined ? {} : { observedFast: fast }),
    ...(at === undefined ? {} : { observedModelAt: at }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextAt === undefined ? {} : { contextAt }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
