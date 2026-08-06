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

import { InstantSchema, type SessionState } from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';

/** The harness-observed runtime, as the transcript last stated it. */
export interface ObservedRuntime {
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** The timestamp of the newest record that carried either value. */
  readonly at?: string;
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
  return candidate !== undefined && InstantSchema.safeParse(candidate).success ? candidate : undefined;
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
  let at: string | undefined;
  for (const event of events) {
    const observed =
      event.kind === 'settings'
        ? { model: stated(event.settings.model), effort: stated(event.settings.reasoningEffort) }
        : event.kind === 'usage'
          ? { model: stated(event.usage.model), effort: undefined }
          : undefined;
    if (observed === undefined || (observed.model === undefined && observed.effort === undefined)) continue;
    if (observed.model !== undefined) model = observed.model;
    if (observed.effort !== undefined) reasoningEffort = observed.effort;
    at = instant(event.timestamp) ?? at;
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
  current: Pick<SessionState, 'observedModel' | 'observedModelAt' | 'observedReasoningEffort'>,
  observed: ObservedRuntime,
): Partial<SessionState> {
  const model = observed.model ?? current.observedModel;
  const reasoningEffort = observed.reasoningEffort ?? current.observedReasoningEffort;
  const at = observed.at ?? current.observedModelAt;
  if (
    model === current.observedModel &&
    reasoningEffort === current.observedReasoningEffort &&
    at === current.observedModelAt
  )
    return {};
  return {
    ...(model === undefined ? {} : { observedModel: model }),
    ...(reasoningEffort === undefined ? {} : { observedReasoningEffort: reasoningEffort }),
    ...(at === undefined ? {} : { observedModelAt: at }),
  };
}
