/**
 * The owner card for a staged 2FA seed: the daemon's words, the one-factor warning to tick, the amber box when the
 * key does not look like this account's, Allow (the stage-bound `add-2fa-key` passkey, then the commit) and Deny.
 * It holds no key: the seed lives sealed in the daemon, and the card has only the stage's id.
 */

import { LOGIN_TOTP_WARNING } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { DISMISSED_WORDS } from '../../lib/automatic-codes.ts';
import {
  SEED_UNCHECKED_WORDS,
  type SeedCardFacts,
  type SeedCheck,
  seedAllowBlocked,
} from '../../lib/two-factor-seed-card.ts';

export type SeedCardPhase =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'passkey' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'done'; readonly words: string; readonly ok: boolean }
  | { readonly kind: 'failed'; readonly words: string };

export interface TwoFactorSeedCardProps {
  readonly subject: string;
  readonly facts: SeedCardFacts;
  readonly phase: SeedCardPhase;
  /** Whether the daemon has said if this key was staged as a mismatch; Allow stays off until it has. */
  readonly check?: SeedCheck;
  readonly onRetry?: () => void;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}

export function TwoFactorSeedCard({
  subject,
  facts,
  phase,
  check = 'ok',
  onRetry,
  onAllow,
  onDeny,
}: TwoFactorSeedCardProps): ReactNode {
  const [warningTick, setWarningTick] = useState(false);
  const [mismatchTick, setMismatchTick] = useState(false);
  const busy = phase.kind === 'passkey' || phase.kind === 'saving';
  const blocked = seedAllowBlocked({ mismatch: facts.mismatch, warningTick, mismatchTick });
  const settled = phase.kind === 'done';

  return (
    <section className="flex min-w-0 flex-col gap-3" data-seed-card="" data-seed-state={phase.kind}>
      <h3 className="m-0 text-ui font-semibold text-fg" data-seed-subject="">
        {subject}
      </h3>
      {facts.lines.length === 0 ? null : (
        <ul className="m-0 flex min-w-0 list-disc flex-col gap-1 pl-5 text-cell text-fg" data-seed-lines="">
          {facts.lines.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {facts.mismatch ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-control border border-warn p-2" data-seed-mismatch="">
          <p className="m-0 text-cell text-warn">
            This key does not look like it belongs to this account. If you did not expect that, Deny.
          </p>
          <label className="flex items-start gap-2 text-cell text-fg">
            <input
              checked={mismatchTick}
              data-seed-mismatch-tick=""
              disabled={busy || settled}
              onChange={event => setMismatchTick(event.target.checked)}
              type="checkbox"
            />
            Save it here anyway
          </label>
        </div>
      ) : null}

      {settled ? (
        <p className={`m-0 text-ui ${phase.ok ? 'text-ok' : 'text-muted'}`} data-seed-done="" role="status">
          {phase.words}
        </p>
      ) : (
        <>
          <label className="flex items-start gap-2 text-cell text-fg">
            <input
              checked={warningTick}
              data-seed-warning-tick=""
              disabled={busy}
              onChange={event => setWarningTick(event.target.checked)}
              type="checkbox"
            />
            <span data-seed-warning="">{LOGIN_TOTP_WARNING}</span>
          </label>

          {phase.kind === 'passkey' ? (
            <p className="m-0 text-cell text-fg" data-seed-passkey="" role="status">
              Confirm with your passkey to save this key. Nothing is saved until you do.
            </p>
          ) : null}
          {phase.kind === 'failed' ? (
            <p className="m-0 text-ui text-err" data-seed-failed="" role="alert">
              {phase.words === DISMISSED_WORDS ? `${phase.words} Allow to try again, or Deny.` : phase.words}
            </p>
          ) : null}
          {check === 'failed' ? (
            <p
              className="m-0 flex flex-wrap items-center gap-2 text-cell text-warn"
              data-seed-unchecked=""
              role="status"
            >
              {SEED_UNCHECKED_WORDS}
              {onRetry === undefined ? null : (
                <button className="kt-btn min-h-[44px]" data-seed-retry="" onClick={onRetry} type="button">
                  Try again
                </button>
              )}
            </p>
          ) : null}
          {blocked !== undefined && !busy ? (
            <p className="m-0 text-meta text-muted" data-seed-blocked="">
              {blocked}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <button className="kt-btn min-h-[44px]" data-seed-deny="" disabled={busy} onClick={onDeny} type="button">
              Deny
            </button>
            <button
              className="kt-btn min-h-[44px] justify-center"
              data-seed-allow=""
              data-variant="primary"
              disabled={blocked !== undefined || busy || check !== 'ok'}
              onClick={onAllow}
              type="button"
            >
              {phase.kind === 'saving' ? 'Saving…' : 'Allow'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
