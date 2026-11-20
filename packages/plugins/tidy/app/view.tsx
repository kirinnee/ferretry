import type { ReactNode } from 'react';
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

/** One row of a Settings card (the shell's `kt-groupcard`): a name and a line under it on the left, the control on the right. */
function Row({
  name,
  hint,
  control,
  eligible,
}: {
  readonly name: string;
  readonly hint?: ReactNode;
  readonly control: ReactNode;
  readonly eligible?: boolean;
}) {
  return (
    <li
      className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-panel pr-panel"
      {...(eligible === undefined ? {} : { 'data-eligible': String(eligible) })}
    >
      <span className="flex min-w-0 flex-1 basis-40 flex-col">
        <span className="text-ui font-semibold text-fg">{name}</span>
        {hint === undefined ? null : <span className="text-meta leading-tight text-muted">{hint}</span>}
      </span>
      {control}
    </li>
  );
}

/** Settings › Tidy: what the daemon would clear of stopped ferrets' files, and a button to clear it now. */
export function TidyView({ plan, error, sweeping, last, onSweep }: TidyViewProps) {
  const eligible = plan?.filter(each => each.eligible) ?? [];
  const total = eligible.reduce((sum, each) => sum + each.bytes, 0);
  return (
    <section aria-labelledby="tidy-heading" className="flex min-w-0 flex-col" data-tidy>
      <p id="tidy-heading" className="m-0 mb-8 px-1 text-ui text-muted">
        Clears the files stopped ferrets left in their own folders, once they have been stopped for a while.
      </p>
      {error === undefined ? null : (
        <p className="m-0 mb-8 px-1 text-meta text-err" role="alert">
          {error}
        </p>
      )}
      {plan === undefined ? (
        <p className="m-0 mb-8 px-1 text-ui text-muted" role="status">
          Reading what could be cleared…
        </p>
      ) : (
        <section className="mb-8 min-w-0">
          <h3 className="m-0 mb-1 px-1 text-meta font-semibold uppercase tracking-wide text-muted">Stopped ferrets</h3>
          <ul className="kt-groupcard kt-groupcard--flat m-0 list-none p-0">
            <Row
              name="Can be cleared"
              hint={
                <span data-tidy-total>
                  {eligible.length === 0
                    ? 'Nothing to clear right now.'
                    : `${humanBytes(total)} can be cleared from ${eligible.length} stopped ferret(s).`}
                </span>
              }
              control={
                <button
                  type="button"
                  className="kt-btn kt-btn--sm min-h-[44px]"
                  data-variant="primary"
                  disabled={sweeping || eligible.length === 0}
                  onClick={onSweep}
                >
                  {sweeping ? 'Clearing…' : 'Clear now'}
                </button>
              }
            />
            {plan.map(each => (
              <Row
                key={each.ferret}
                name={each.name ?? each.ferret}
                hint={each.eligible ? undefined : `(kept: ${each.reason})`}
                eligible={each.eligible}
                control={<span className="text-ui text-fg">{humanBytes(each.bytes)}</span>}
              />
            ))}
          </ul>
        </section>
      )}
      {last === undefined ? null : (
        <p className="m-0 px-1 text-ui text-fg" role="status" data-tidy-last>
          Cleared {humanBytes(last.bytes)} from {last.ferrets} ferret(s)
          {last.failures === 0 ? '.' : `; ${last.failures} item(s) could not be removed.`}
        </p>
      )}
    </section>
  );
}
