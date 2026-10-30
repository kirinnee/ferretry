/**
 * Info › Overview › Warden: what the Warden has said and done about this ferret, newest first.
 *
 * The daemon's verdict list narrowed to this session (the route has no per-session filter, so the narrowing is here),
 * each with what the Warden did and why. It sits beside the agenda in Overview: Info has no Signals tab.
 */

import type { WardenVerdict } from '@ferretry/protocol';
import { Shield } from 'lucide-react';
import { relativeTime } from '../../lib/session-screens.ts';
import { InfoNote } from './info-parts.tsx';
export type InfoVerdictsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly verdicts: readonly WardenVerdict[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** What the Warden did, in words. */
export const VERDICT_WORDS: Readonly<Record<WardenVerdict['verdict'], string>> = {
  killed: 'Stopped it',
  revived: 'Revived it',
  nudged: 'Nudged it',
  cleared: 'Left it alone — healthy',
  needs_human: 'Asked for you',
  unknown: 'No clear verdict',
};

/** This session's verdicts, newest first. */
export const sessionVerdicts = (verdicts: readonly WardenVerdict[], sessionId: string): WardenVerdict[] =>
  verdicts
    .filter(verdict => verdict.targetSession === sessionId)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

export function InfoWarden({
  agentName,
  sessionId,
  verdicts,
  now,
}: {
  readonly agentName: string;
  readonly sessionId: string;
  readonly verdicts: InfoVerdictsRead;
  readonly now: () => number;
}) {
  const mine = verdicts.kind === 'ready' ? sessionVerdicts(verdicts.verdicts, sessionId) : [];
  const nowMs = now();
  return (
    <section className="fy-info-section" data-info-warden="">
      <h3 className="fy-info-section__title">Warden</h3>
      {verdicts.kind === 'loading' ? (
        <InfoNote>Reading the Warden’s verdicts…</InfoNote>
      ) : verdicts.kind === 'failed' ? (
        <InfoNote>Couldn’t read the Warden’s verdicts: {verdicts.reason}</InfoNote>
      ) : mine.length === 0 ? (
        <InfoNote>The Warden has nothing to say about {agentName}.</InfoNote>
      ) : (
        <ul className="fy-info-verdicts">
          {mine.map(verdict => (
            <li
              className="fy-info-verdict"
              data-info-verdict={verdict.verdict}
              key={`${verdict.reportPath}-${verdict.at}`}
            >
              <Shield aria-hidden="true" size={14} />
              <div>
                <strong>{VERDICT_WORDS[verdict.verdict]}</strong>
                <span className="fy-info-muted"> · {relativeTime(verdict.at, nowMs)}</span>
                {verdict.anomalyKind === undefined ? null : (
                  <span className="fy-info-muted"> · {verdict.anomalyKind.replaceAll('_', ' ')}</span>
                )}
                {verdict.reason === undefined ? null : <p className="fy-info-verdict__why">{verdict.reason}</p>}
                {verdict.recommendation === undefined ? null : (
                  <p className="fy-info-verdict__why">
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
