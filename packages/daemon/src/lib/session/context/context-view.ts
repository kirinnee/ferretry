import type { SessionContext, SessionView } from '@ferretry/protocol';
import type { SessionDirectorySubsystem } from '../../runtime/mounts/sessions.ts';
import { contextPercent, knownContextWindowForSession } from '../../core/context-window.ts';

/**
 * Puts `context: { usedTokens, windowTokens, percent, at }` on the session views whose context size AND
 * window are both known, and leaves every other view as it is.
 *
 * TWO FACTS, TWO OWNERS. The size is what the transcript's newest usage record said — the observer stores
 * it as `contextTokens` and `contextAt` (see `projectObservedContext`). The window is a fact about the
 * model, resolved here with the same rule a plan uses ({@link knownContextWindowForSession}) minus its
 * default: a model whose window nothing states has no ring, never a 200k guess.
 *
 * It wraps the session reader at the mount, like `withOutdated`, because the window needs the account's
 * model catalog, which the reader has no business holding. The catalog is read once per `ttlMs`, not per
 * session: a list renders every ferret and nothing about a catalog changes faster than a person looks.
 * A failed catalog read is a catalog that declares nothing — the window is then known only from the
 * harness's report and the model's own selector, and a roster never fails to load because of a ring.
 *
 * `state.contextPercent` — an older field nothing wrote — is filled from the same number, so a surface that
 * has read it all along (the CLI, the session rows) lights up without a second derivation.
 */

/** What the catalog declares for a session's model, answered for the whole roster at once. */
export type DeclaredWindows = (view: SessionView) => number | undefined;

export interface ContextViewPorts {
  readonly declared: () => Promise<DeclaredWindows>;
  /** Real windows for models whose id says nothing about their size, matched by substring. */
  readonly overrides: Readonly<Record<string, number>>;
  readonly now: () => number;
  readonly ttlMs: number;
}

const NOTHING_DECLARED: DeclaredWindows = () => undefined;

/** The context of one view, or `undefined` when the size or the window is unknown. */
export function sessionContextOf(
  view: Pick<SessionView, 'config' | 'state'>,
  declaredWindow: number | undefined,
  overrides: Readonly<Record<string, number>> = {},
): SessionContext | undefined {
  const { state, config } = view;
  if (state.contextTokens === undefined || state.contextAt === undefined) return undefined;
  const windowTokens = knownContextWindowForSession({
    configuredModel: config.model,
    modelHint: config.modelHint,
    observedModel: state.observedModel,
    reportedWindow: state.contextWindow,
    overrides,
    ...(declaredWindow === undefined ? {} : { declaredWindow }),
  });
  if (windowTokens === undefined) return undefined;
  return {
    usedTokens: state.contextTokens,
    windowTokens,
    percent: contextPercent(state.contextTokens, windowTokens),
    at: state.contextAt,
  };
}

export function withContext(reader: SessionDirectorySubsystem, ports: ContextViewPorts): SessionDirectorySubsystem {
  let cached: { readonly at: number; readonly declared: DeclaredWindows } | undefined;
  const declaredNow = async (): Promise<DeclaredWindows> => {
    if (cached !== undefined && ports.now() - cached.at < ports.ttlMs) return cached.declared;
    const declared = await ports.declared().catch(() => NOTHING_DECLARED);
    cached = { at: ports.now(), declared };
    return declared;
  };
  const mark = (view: SessionView, declared: DeclaredWindows): SessionView => {
    const context = sessionContextOf(view, declared(view), ports.overrides);
    return context === undefined
      ? view
      : { ...view, state: { ...view.state, contextPercent: context.percent }, context };
  };
  return {
    list: async () => {
      const views = await reader.list();
      const declared = await declaredNow();
      return views.map(view => mark(view, declared));
    },
    get: async reference => {
      const view = await reader.get(reference);
      return view === undefined ? undefined : mark(view, await declaredNow());
    },
  };
}
