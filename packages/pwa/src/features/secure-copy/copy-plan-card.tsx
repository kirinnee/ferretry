/**
 * A ferret's PLAN of pastes, asked before it starts (docs/secure-copy.md): one card listing each paste it means to
 * make, what it copies from and where it goes, in the daemon's words, with the ferret's reason small beneath. The
 * owner ticks the ones it allows; each becomes a rule for that ferret allowing ONE paste until the plan's end.
 * Allowing none declines the plan. Nothing here is a value.
 */

import type { CopyPlan } from '@ferretry/protocol';
import { useState } from 'react';
import { fromWords, toWords } from '../../lib/secure-copy.ts';

export interface CopyPlanCardProps {
  readonly plan: CopyPlan;
  readonly agentName: string;
  /** Allows the items by index; an empty list declines. Resolves to the sentence to show, or rejects with why. */
  readonly onAnswer: (items: readonly number[]) => Promise<string>;
}

const when = (instant: string): string => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

export function CopyPlanCard({ plan, agentName, onAnswer }: CopyPlanCardProps) {
  const [ticked, setTicked] = useState<readonly number[]>(() => plan.items.map((_item, index) => index));
  const [sending, setSending] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const answer = async (items: readonly number[]): Promise<void> => {
    setSending(true);
    setFailure(null);
    try {
      setSettled(await onAnswer(items));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  if (settled !== null)
    return (
      <p className="m-0 text-ui text-ok" data-copy-plan-settled="" role="status">
        {settled}
      </p>
    );

  const toggle = (index: number): void =>
    setTicked(current =>
      current.includes(index) ? current.filter(each => each !== index) : [...current, index].sort((a, b) => a - b),
    );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-copy-plan={plan.id}>
      <p className="m-0 text-cell text-muted">
        Each ticked paste goes through once, without asking, until <span className="mono">{when(plan.expiresAt)}</span>.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Planned pastes">
        {plan.items.map((item, index) => {
          const id = `${plan.id}-${String(index)}`;
          return (
            <li
              className="flex items-start gap-3 rounded-control border border-border bg-surface-2 p-3"
              data-copy-plan-item={index}
              key={id}
            >
              <input
                checked={ticked.includes(index)}
                className="mt-1 h-5 w-5 shrink-0"
                data-copy-plan-tick={index}
                disabled={sending}
                id={id}
                onChange={() => toggle(index)}
                type="checkbox"
              />
              <label className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1" htmlFor={id}>
                <span className="min-w-0 break-words text-ui text-fg" data-copy-route="">
                  {fromWords(item.from)}
                  {'\u00a0→ '}
                  <span className="font-medium">{toWords(item.to)}</span>
                </span>
                <span className="text-meta text-faint" data-copy-plan-why="">
                  {agentName} says: “{item.why}”
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {failure === null ? null : (
        <p className="m-0 text-ui text-err" data-copy-plan-failure="" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2" data-copy-plan-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-copy-plan-decline=""
          disabled={sending}
          onClick={() => void answer([])}
          type="button"
        >
          Decline all
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-copy-plan-allow=""
          data-variant="primary"
          disabled={sending || ticked.length === 0}
          onClick={() => void answer(ticked)}
          type="button"
        >
          {sending
            ? 'Allowing…'
            : ticked.length === plan.items.length
              ? `Allow ${ticked.length === 1 ? 'it' : `all ${String(ticked.length)}`}`
              : `Allow ${String(ticked.length)} of ${String(plan.items.length)}`}
        </button>
      </div>
    </div>
  );
}
