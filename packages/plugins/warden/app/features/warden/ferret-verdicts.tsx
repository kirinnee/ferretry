/**
 * Info › Warden: what the Warden has said and done about one ferret, newest first.
 *
 * The daemon's verdict list narrowed to this ferret (the route has no per-ferret filter, so the narrowing is here),
 * each with what the Warden did and why. Pure over what it is handed: the panel (`views/warden-ferret.tsx`) reads.
 */

import { relativeTime } from '@ferretry/app';
import { Shield } from 'lucide-react';
import type { WardenVerdict } from '../../wire.ts';

export type FerretVerdictsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly verdicts: readonly WardenVerdict[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** What the Warden did, in words. */
const VERDICT_WORDS: Readonly<Record<WardenVerdict['verdict'], string>> = {
  killed: 'Stopped it',
  revived: 'Revived it',
  nudged: 'Nudged it',
  cleared: 'Left it alone — healthy',
  needs_human: 'Asked for you',
  unknown: 'No clear verdict',
};

/** This ferret's verdicts, newest first. */
const ferretVerdicts = (verdicts: readonly WardenVerdict[], ferret: string): WardenVerdict[] =>
  verdicts
    .filter(verdict => verdict.target === ferret)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

export function FerretVerdicts({
  name,
  ferret,
  verdicts,
  now,
}: {
  /** What the ferret is called, for the sentence that says there is nothing. */
  readonly name: string;
  readonly ferret: string;
  readonly verdicts: FerretVerdictsRead;
  readonly now: () => number;
}) {
  const mine = verdicts.kind === 'ready' ? ferretVerdicts(verdicts.verdicts, ferret) : [];
  const nowMs = now();
  return (
    <section className="flex min-w-0 flex-col gap-sm" data-ferret-warden="">
      <h3 className="m-0 text-cell font-semibold text-fg">Warden</h3>
      {verdicts.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading the Warden’s verdicts…
        </p>
      ) : verdicts.kind === 'failed' ? (
        <p className="m-0 text-cell text-muted" data-ferret-warden-failed="" role="alert">
          Couldn’t read the Warden’s verdicts: {verdicts.reason}
        </p>
      ) : mine.length === 0 ? (
        <p className="m-0 text-cell text-muted" role="status">
          The Warden has nothing to say about {name}.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {mine.map(verdict => (
            <li
              className="flex min-w-0 gap-sm"
              data-ferret-verdict={verdict.verdict}
              key={`${verdict.reportPath}-${verdict.at}`}
            >
              <Shield aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
              <div className="min-w-0">
                <strong>{VERDICT_WORDS[verdict.verdict]}</strong>
                <span className="text-muted"> · {relativeTime(verdict.at, nowMs)}</span>
                {verdict.anomalyKind === undefined ? null : (
                  <span className="text-muted"> · {verdict.anomalyKind.replaceAll('_', ' ')}</span>
                )}
                {verdict.reason === undefined ? null : <p className="m-0 break-words text-cell">{verdict.reason}</p>}
                {verdict.recommendation === undefined ? null : (
                  <p className="m-0 break-words text-cell">
                    Recommended: {verdict.recommendation.action} — {verdict.recommendation.reason}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
