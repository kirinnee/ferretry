/**
 * PEER: today's `packages/daemon/src/lib/session/compact-at/resolve.ts` (owner: conversation).
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */
import { type CompactAt, checkCompactAt, describeCompactAt } from '../../protocol/compact-at.ts';

/** What a launch carries for the compaction trigger, and why a configured value was not used. */
export interface CompactAtResolution {
  readonly effective: CompactAt;
  /** Set when a configured value was dropped to Auto because the launch model cannot honour it. */
  readonly ignored?: string;
}

/**
 * The value a launch uses: the ferret's own, else its login's default, else Auto. A configured value the launch
 * model cannot honour (a default larger than its window, or a window that shrank under a model change) is dropped
 * to Auto rather than refusing the launch — a lower trigger is better than a ferret that will not start.
 */
export function resolveCompactAt(
  facts: { readonly own: CompactAt | undefined; readonly accountDefault: CompactAt | undefined },
  window: number | undefined,
): CompactAtResolution {
  const own = facts.own !== undefined;
  const wanted = facts.own ?? facts.accountDefault ?? 'auto';
  const refusal = checkCompactAt(wanted, window);
  if (refusal === undefined) return { effective: wanted };
  return {
    effective: 'auto',
    ignored: `${own ? 'This ferret’s own' : 'This login’s default'} ${describeCompactAt(wanted)} is not used: ${refusal}`,
  };
}
