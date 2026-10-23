/**
 * AVAILABLE NOW: the models a runtime on this machine offers as it stands (`GET /v1/pack` › `available`),
 * in the daemon's order — the ready ones first, then by quota left. Read-only: it is what a ferret and Jev
 * choose from, next to the routing prompt that tells them how.
 *
 * Each row says where the routing prompt names it ("named 1st") and the effort it names, so the owner can
 * see the order `fy new --auto` would try. A row that cannot start says why, in the refusal's own words.
 */

import type { PackModelOption } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import { ordinal, QUOTA_CHIP } from '../../lib/pack/routing-prompt.ts';
import { Badge } from '../../shell/primitives.tsx';

function OptionRow({ option }: { readonly option: PackModelOption }) {
  const quota = QUOTA_CHIP[option.quota.state];
  return (
    <li
      className="flex min-w-0 flex-col gap-1 border-t border-border-soft py-2 first:border-t-0"
      data-available-model={option.model}
      data-available-ready={option.ready ? 'yes' : 'no'}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn('min-w-0 break-words text-ui font-semibold', !option.ready && 'text-muted')}>
          {option.modelLabel}
        </span>
        <span className="mono min-w-0 break-all text-meta text-muted">{option.model}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta text-muted">
        <span className="mono min-w-0 break-all" title={`${option.runtimes} runtime(s) here offer it`}>
          {option.runtime}
        </span>
        {option.named === undefined ? null : (
          <Badge tone="accent" data-available-named={option.named}>
            Named {ordinal(option.named)}
          </Badge>
        )}
        {option.effort === undefined ? null : (
          <Badge tone="pend" data-available-effort={option.effort}>
            Effort {option.effort}
          </Badge>
        )}
        <Badge tone={quota.tone} title={option.quota.summary} data-available-quota={option.quota.state}>
          {quota.label}
        </Badge>
        {option.ready ? null : <Badge tone="pend">Not ready</Badge>}
      </div>
      {option.refusal === undefined ? null : (
        <p className="m-0 min-w-0 break-words text-meta leading-base text-faint" data-available-refusal="">
          {option.refusal.message}
          {option.refusal.remedy === undefined ? '' : ` ${option.refusal.remedy}`}
        </p>
      )}
    </li>
  );
}

export function AvailableNow({
  available,
  headingId,
}: {
  readonly available: readonly PackModelOption[];
  readonly headingId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-available-now="">
      <h4 id={headingId} className="m-0 text-ui font-semibold">
        Available now
      </h4>
      <p className="m-0 text-meta leading-base text-muted">
        What runtimes here can start right now, ready first, then by quota left.
      </p>
      {available.length === 0 ? (
        <p className="m-0 text-meta text-warn">No runtime on this machine offers a model right now.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" aria-labelledby={headingId}>
          {available.map(option => (
            <OptionRow key={`${option.provider ?? ''}:${option.harness}:${option.model}`} option={option} />
          ))}
        </ul>
      )}
    </div>
  );
}
