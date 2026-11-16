/**
 * HOW A PROFILE'S BASES ARE EXPANDED (P1, P2, P3) — the one rule, shared by the daemon's resolver and by any reader that
 * must show what the resolver will do (the profile page's instruction text). It lives in the contract so the browser
 * and the daemon cannot grow two orderings: a second copy is how a screen comes to say "A then B" while a ferret is told
 * "B then A".
 *
 * Pure and total: no filesystem, no environment, no clock, and every failure is a value.
 */

/** Deepest chain of bases a profile may sit under (the start counts as one). A second line of defence. */
export const MAX_STACK_DEPTH = 64;

/** Most layers one profile may expand to, before it is cut to one copy of each. A second line of defence. */
export const MAX_STACK_LAYERS = 10_000;

/** One component of an expanded stack: `via` is the bases it came through, relative to the profile asked about. */
interface StackEntry<T> {
  readonly key: string;
  readonly item: T;
  readonly via: readonly string[];
}

/** What one layer text of a profile is, as the caller reads it. */
export type StackLayer<T, F> =
  | { readonly kind: 'base'; readonly name: string }
  | { readonly kind: 'leaf'; readonly key: string; readonly item: T }
  | { readonly kind: 'fail'; readonly failure: F };

/** Why a stack could not be expanded. `chain` runs from the profile asked about down to the profile concerned. */
export type StackFailure<F> =
  | { readonly kind: 'unknown-profile'; readonly profile: string; readonly chain: readonly string[] }
  | { readonly kind: 'loop'; readonly profile: string; readonly cycle: readonly string[] }
  | { readonly kind: 'layer'; readonly failure: F; readonly chain: readonly string[] }
  | { readonly kind: 'too-deep'; readonly limit: number }
  | { readonly kind: 'too-large'; readonly profile: string; readonly limit: number };

export type StackExpansion<T, F> =
  | { readonly ok: true; readonly entries: readonly StackEntry<T>[] }
  | { readonly ok: false; readonly failure: StackFailure<F> };

/**
 * THE one place a profile's bases are expanded (P1, P2, P3): every `profile/<base>` layer is replaced where it
 * stands, each component is kept once at its NEWEST position, and a profile that reaches itself is refused.
 *
 * A base is expanded ONCE, however many profiles reach it: its expansion does not depend on who reached it, so it is
 * remembered with each `via` relative to the base and the parent prefixes it when splicing it in. Keeping only the
 * newest copy of a component per profile before the parent concatenates gives the same list as keeping it once at the
 * end. Only a base whose whole subtree resolved is remembered, and everything below such a base is known to be free of
 * loops, so a remembered base can never hide one. The depth and size bounds keep the answer small however the
 * profile files are written.
 *
 * A reader that can never answer `fail` (its layers cannot fail to parse) gets an expansion whose failure has no
 * 'layer' arm, so the caller narrows by type rather than by cast; a reader that gains a `fail` answer stops matching
 * that overload and the caller stops compiling.
 */
export function expandStack<T>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, never>,
  start: string,
):
  | { readonly ok: true; readonly entries: readonly StackEntry<T>[] }
  | { readonly ok: false; readonly failure: Exclude<StackFailure<never>, { readonly kind: 'layer' }> };
export function expandStack<T, F>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, F>,
  start: string,
): StackExpansion<T, F>;
export function expandStack<T, F>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, F>,
  start: string,
): StackExpansion<T, F> {
  interface Done {
    readonly entries: readonly StackEntry<T>[];
    /** The profiles on the longest chain of bases below, itself included. */
    readonly height: number;
  }
  type Expanded =
    | { readonly ok: true; readonly done: Done }
    | { readonly ok: false; readonly failure: StackFailure<F> };
  const remembered = new Map<string, Done>();
  const tooDeep: Expanded = { ok: false, failure: { kind: 'too-deep', limit: MAX_STACK_DEPTH } };

  const expand = (name: string, chain: readonly string[]): Expanded => {
    if (chain.length > MAX_STACK_DEPTH) return tooDeep;
    const layers = layersOf(name);
    if (layers === undefined) return { ok: false, failure: { kind: 'unknown-profile', profile: name, chain } };
    const raw: StackEntry<T>[] = [];
    let height = 1;
    for (const text of layers) {
      const layer = read(text);
      if (layer.kind === 'fail') return { ok: false, failure: { kind: 'layer', failure: layer.failure, chain } };
      if (layer.kind === 'leaf') {
        raw.push({ key: layer.key, item: layer.item, via: [] });
        continue;
      }
      const base = layer.name;
      if (chain.includes(base)) {
        return {
          ok: false,
          failure: { kind: 'loop', profile: name, cycle: [...chain.slice(chain.indexOf(base)), base] },
        };
      }
      let inner = remembered.get(base);
      if (inner === undefined) {
        const fresh = expand(base, [...chain, base]);
        if (!fresh.ok) return fresh;
        inner = fresh.done;
      } else if (chain.length + inner.height > MAX_STACK_DEPTH) {
        return tooDeep;
      }
      height = Math.max(height, inner.height + 1);
      for (const entry of inner.entries) raw.push({ key: entry.key, item: entry.item, via: [base, ...entry.via] });
    }
    if (raw.length > MAX_STACK_LAYERS) {
      return { ok: false, failure: { kind: 'too-large', profile: name, limit: MAX_STACK_LAYERS } };
    }
    const newest = new Map<string, number>();
    raw.forEach((entry, index) => {
      newest.set(entry.key, index);
    });
    const done: Done = { entries: raw.filter((entry, index) => newest.get(entry.key) === index), height };
    remembered.set(name, done);
    return { ok: true, done };
  };

  const stack = expand(start, [start]);
  return stack.ok ? { ok: true, entries: stack.done.entries } : stack;
}
