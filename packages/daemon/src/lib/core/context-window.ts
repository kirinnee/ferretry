/** Context accounting for a session, from whatever evidence about its model exists. */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** The marker an extended-context model carries in a configured id but never in a reported one. */
const EXTENDED_MARKER = '[1m]';

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The longest matching override, so a specific model id beats a family name. An override with a
 * value that is not a positive window is ignored rather than believed.
 */
function overrideFor(model: string | undefined, overrides: Readonly<Record<string, number>>): number | undefined {
  if (model === undefined || model.length === 0) return undefined;
  const patterns = Object.keys(overrides)
    .filter(pattern => pattern.length > 0 && model.includes(pattern))
    .sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    const window = positive(overrides[pattern]);
    if (window !== undefined) return window;
  }
  return undefined;
}

export interface ContextWindowEvidence {
  /** The model the session was configured with — the only string carrying the extended marker. */
  readonly configuredModel?: string;
  /** The model the harness reports it is actually serving; the marker is always stripped from it. */
  readonly servedModel?: string;
  /** A window the harness reports about itself. Ground truth when present. */
  readonly reportedWindow?: number;
  /** Real windows for models whose id says nothing about their size, matched by substring. */
  readonly overrides?: Readonly<Record<string, number>>;
}

/**
 * The context evidence recorded by one live session.
 *
 * The configured model and the harness observation must stay separate.  In
 * particular, a wrapper's configured alias can say `opus` while the harness
 * reports the served `glm-5.2`; model-window overrides apply to the latter.
 * Conversely, the `[1m]` selector is retained only in configuration, not in
 * the harness report.  Keeping this projection here prevents callers that
 * compare live and target windows (notably migration) from dropping either
 * half of that evidence.
 */
export interface SessionContextWindowEvidence {
  /** The model selected in the session's configuration. */
  readonly configuredModel?: string;
  /** The configured fallback when the selected model was not recorded. */
  readonly modelHint?: string;
  /** The model the harness says it is actually serving. */
  readonly observedModel?: string;
  /** A context window the harness reports about the running session. */
  readonly reportedWindow?: number;
  readonly overrides?: Readonly<Record<string, number>>;
}

/**
 * The context window for a session.
 *
 * Precedence: a harness that reports its own window is believed verbatim; then configured
 * overrides, matched against the served model with the configured one as fallback; then the
 * extended-context marker; then the default.
 *
 * The marker check is the subtle one. It is a configuration convention that appears only in the
 * configured model id — a live session of such a model reports the bare id back — so deciding from
 * the served model alone gives every extended session the default window and inflates its context
 * percentage roughly fivefold. Both strings are checked.
 */
export function contextWindowFor(evidence: ContextWindowEvidence): number {
  const reported = positive(evidence.reportedWindow);
  if (reported !== undefined) return reported;

  const served = evidence.servedModel?.trim();
  const configured = evidence.configuredModel?.trim();
  const overrides = evidence.overrides;
  if (overrides !== undefined) {
    const window = overrideFor(served !== undefined && served.length > 0 ? served : configured, overrides);
    if (window !== undefined) return window;
  }

  const extended = configured?.includes(EXTENDED_MARKER) === true || served?.includes(EXTENDED_MARKER) === true;
  return extended ? EXTENDED_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolves the context window of an existing session from its persisted
 * configuration and live harness evidence.
 *
 * This is intentionally a small semantic wrapper over {@link contextWindowFor}
 * rather than making every consumer remember which model string is configured
 * and which one is observed.  A migration is destructive, so getting this
 * distinction wrong can incorrectly permit a smaller target window.
 */
export function contextWindowForSession(evidence: SessionContextWindowEvidence): number {
  return contextWindowFor({
    configuredModel: evidence.configuredModel ?? evidence.modelHint,
    servedModel: evidence.observedModel,
    ...(evidence.reportedWindow === undefined ? {} : { reportedWindow: evidence.reportedWindow }),
    ...(evidence.overrides === undefined ? {} : { overrides: evidence.overrides }),
  });
}

/** How much of the window a transcript has consumed, as a percentage that never exceeds 100. */
export function contextPercent(usedTokens: number, window: number): number {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0 || window <= 0) return 0;
  return Math.min(100, Math.round((usedTokens / window) * 1000) / 10);
}
