/**
 * The element a page field is pointed at by (a snapshot ref or a selector), and how the worker turns one into a
 * Playwright locator. Copied from today's `protocol/src/lib/browser-target.ts` (`BrowserElementTarget`) and
 * `daemon/src/lib/browser/transport/page-acts.ts` (`browserSelectorOf`, `browserElementOf`, `staleRefMessage`,
 * `BROWSER_PROBE_TIMEOUT_MS`): only the part the page input target needs, so `target/` stands on its own.
 */

/** A target that is an element: a ref from a page snapshot (`e12`, `f1e3`), or a selector. */
export type ElementTarget =
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'ref'; readonly ref: string };

/** How long a look at one element may wait for it. */
export const BROWSER_PROBE_TIMEOUT_MS = 2_000;

/** The slice of a Playwright locator this needs. */
export interface ElementLocator {
  first(): ElementLocator;
  count(): Promise<number>;
}

/** The slice of a Playwright page this needs. */
export interface ElementPage {
  locator(selector: string): ElementLocator;
}

/** The selector Playwright resolves for a target: a ref through its `aria-ref` engine. */
export function browserSelectorOf(target: ElementTarget): string {
  return target.kind === 'ref' ? `aria-ref=${target.ref}` : target.selector;
}

/** What an agent is told about a ref the page no longer knows. */
export function staleRefMessage(ref: string): string {
  return `${ref} is not on the page's latest snapshot (it changed, or was never read): read the page again with mode "snapshot" and use a fresh ref`;
}

/** The one element a target names. A ref the page no longer knows is refused here, with the fix. */
export async function browserElementOf(page: ElementPage, target: ElementTarget): Promise<ElementLocator> {
  const element = page.locator(browserSelectorOf(target)).first();
  if (target.kind !== 'ref') return element;
  const found = await element.count().catch(() => 0);
  if (found === 0) throw new Error(staleRefMessage(target.ref));
  return element;
}

/** What a snapshot names an element: `e12`, or `f1e3` inside a frame (today's `BROWSER_REF_PATTERN`). */
export const BROWSER_REF_PATTERN = /^(?:f\d{1,6})?e\d{1,7}$/u;

/**
 * An element target as the worker receives one (today's `browserElementParam`): checked, because the worker is its own
 * program and trusts no line it reads. `undefined` when none was sent.
 */
export function elementParam(value: unknown): ElementTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('target must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'selector' && typeof raw.selector === 'string' && raw.selector)
    return { kind: 'selector', selector: raw.selector };
  if (raw.kind === 'ref' && typeof raw.ref === 'string' && BROWSER_REF_PATTERN.test(raw.ref))
    return { kind: 'ref', ref: raw.ref };
  throw new Error('target is not a ref or a selector');
}
