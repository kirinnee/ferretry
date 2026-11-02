/**
 * Revoke ALL of one account's standing rules, from the account's own page. It only takes away, so there is no passkey:
 * the count is read first and the owner confirms it, and the answer says how many the machine revoked.
 */

import type { AccountSummary } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { failureWords, revokeAccountRules } from '../../lib/sign-in-rules.ts';
import { type RulesBinding, useSignInRules } from './use-sign-in-rules.ts';

const rulesWords = (count: number): string => `${String(count)} standing ${count === 1 ? 'rule' : 'rules'}`;

export function AccountRulesRevoke({
  rules,
  account,
}: {
  readonly rules: RulesBinding;
  readonly account: AccountSummary;
}): ReactNode {
  const { read, reload } = useSignInRules(rules.client);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly words: string } | undefined>(undefined);

  const count = read.kind === 'ready' ? read.list.rules.filter(each => each.account.id === account.id).length : 0;
  if (read.kind !== 'ready' || (count === 0 && outcome === undefined)) return null;

  const revoke = (): void => {
    setBusy(true);
    void revokeAccountRules(rules.client, account.id).then(
      revoked => {
        setBusy(false);
        setConfirming(false);
        setOutcome({ ok: true, words: `Revoked ${rulesWords(revoked)}. Ferrets ask you each time again.` });
        reload();
      },
      cause => {
        setBusy(false);
        setOutcome({ ok: false, words: failureWords(cause) });
      },
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" data-account-rules="" aria-label="Standing rules">
      {count === 0 ? null : (
        <>
          <p className="m-0 text-cell text-muted" data-account-rules-count="">
            {account.label} has {rulesWords(count)} listed here. Revoking takes every standing rule of this account,
            listed or not, and needs no passkey: ferrets ask you each time again.
          </p>
          <div className="flex flex-wrap gap-2">
            {confirming ? (
              <>
                <button
                  className="kt-btn min-h-[44px]"
                  data-account-rules-confirm=""
                  data-variant="danger"
                  disabled={busy}
                  onClick={revoke}
                  type="button"
                >
                  Revoke {rulesWords(count)}
                </button>
                <button
                  className="kt-btn min-h-[44px]"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  type="button"
                >
                  Keep them
                </button>
              </>
            ) : (
              <button
                className="kt-btn min-h-[44px]"
                data-account-rules-revoke=""
                data-variant="danger"
                disabled={busy}
                onClick={() => setConfirming(true)}
                type="button"
              >
                Revoke all standing rules…
              </button>
            )}
          </div>
        </>
      )}
      {outcome === undefined ? null : (
        <p
          className={`m-0 text-ui ${outcome.ok ? 'text-muted' : 'text-err'}`}
          data-account-rules-outcome={outcome.ok ? 'revoked' : 'failed'}
          role={outcome.ok ? 'status' : 'alert'}
        >
          {outcome.words}
        </p>
      )}
    </section>
  );
}
