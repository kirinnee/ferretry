/**
 * The compaction trigger a launch carries: v4's `currentLaunchCompactAt -> resolveCompactAt`, in the one launch path.
 *
 * - The ferret's OWN value wins over its login's default, and an own `auto` suppresses a numeric default.
 * - A value the selected model cannot honour (larger than its context window) is not passed to the harness at all: the
 *   launch falls back to Auto, because a lower trigger beats a ferret that will not start. The own value is dropped
 *   to Auto; it never falls through to the login's default.
 * - The window is v4's `contextWindowFor`: a `[1m]` selector states 1M, else the model's declared `context`, else 200k.
 */

/** v4's default window for a model whose id and catalog state none. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The window a `[1m]` selector states. */
const EXTENDED_CONTEXT_WINDOW = 1_000_000;
const EXTENDED_MARKER = '[1m]';
const SELECTOR = /\[[^\]]*\]$/u;

/** The model facts a window needs: the account's default model and the context its catalog declares per model. */
export interface ModelWindows {
  readonly defaultModel?: string;
  readonly models: readonly { readonly id: string; readonly context?: number }[];
}

/** The window of the model a launch is on (the one it names, else the login's default), as v4 planned it. */
export function launchContextWindow(model: string | undefined, facts: ModelWindows): number {
  const selected = model ?? facts.defaultModel;
  if (selected?.includes(EXTENDED_MARKER) === true) return EXTENDED_CONTEXT_WINDOW;
  const bare = selected?.replace(SELECTOR, '');
  const declared =
    selected === undefined
      ? undefined
      : (facts.models.find(entry => entry.id === selected) ?? facts.models.find(entry => entry.id === bare))?.context;
  return declared ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * The number of tokens the harness is to compact at, or `undefined` for Auto (nothing is written).
 * `own` and `accountDefault` are as configured: a token count or `'auto'`; absent is "not set".
 */
export function resolveLaunchCompactAt(input: {
  readonly own: 'auto' | number | undefined;
  readonly accountDefault: number | undefined;
  readonly window: number;
}): number | undefined {
  const wanted = input.own ?? input.accountDefault ?? 'auto';
  return wanted === 'auto' || wanted > input.window ? undefined : wanted;
}
