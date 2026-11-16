import type { ScratchPlanView, ScratchSweepView } from '../contract/index.ts';

/** Compact byte counts, as `fy gc` prints them. */
export function humanBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

export interface TidyViewProps {
  /** `undefined` while the plan is being read. */
  readonly plan: readonly ScratchPlanView[] | undefined;
  readonly error?: string | undefined;
  readonly sweeping: boolean;
  readonly last?: ScratchSweepView | undefined;
  readonly onSweep: () => void;
}

/** Settings › Tidy: what the daemon would clear of stopped ferrets' files, and a button to clear it now. */
export function TidyView({ plan, error, sweeping, last, onSweep }: TidyViewProps) {
  const eligible = plan?.filter(each => each.eligible) ?? [];
  const total = eligible.reduce((sum, each) => sum + each.bytes, 0);
  return (
    <section aria-labelledby="tidy-heading" data-tidy>
      <h2 id="tidy-heading">Tidy</h2>
      <p>Clears the files stopped ferrets left in their own folders, once they have been stopped for a while.</p>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {plan === undefined ? (
        <p role="status">Reading what could be cleared…</p>
      ) : (
        <>
          <p data-tidy-total>
            {eligible.length === 0
              ? 'Nothing to clear right now.'
              : `${humanBytes(total)} can be cleared from ${eligible.length} stopped ferret(s).`}
          </p>
          <ul>
            {plan.map(each => (
              <li key={each.ferret} data-eligible={each.eligible}>
                <strong>{each.name ?? each.ferret}</strong> — {humanBytes(each.bytes)}
                {each.eligible ? '' : ` (kept: ${each.reason})`}
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" disabled={sweeping || eligible.length === 0} onClick={onSweep}>
        {sweeping ? 'Clearing…' : 'Clear now'}
      </button>
      {last === undefined ? null : (
        <p role="status" data-tidy-last>
          Cleared {humanBytes(last.bytes)} from {last.ferrets} ferret(s)
          {last.failures === 0 ? '.' : `; ${last.failures} item(s) could not be removed.`}
        </p>
      )}
    </section>
  );
}
