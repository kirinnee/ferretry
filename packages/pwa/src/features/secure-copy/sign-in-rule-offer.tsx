/**
 * The quiet offer after the owner hand-tapped a saved sign-in on an input card: "Don’t ask again for this sign-in…".
 * It only opens the owner's own sheet with nothing ticked; no rule exists until the owner approves it with a passkey.
 * The names come from the secrets-gated accounts route, read when the owner opens the sheet.
 */

import type { AccountSummary, SignInSummary } from '@ferretry/protocol';
import { useState } from 'react';
import { readAccounts } from '../../lib/input-api.ts';
import { failureWords, isForbidden, RULE_NO_ACCOUNTS_DEVICE_WORDS, type RuleClient } from '../../lib/sign-in-rules.ts';
import { SignInRuleSheetHost } from '../accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';

export interface SignInRuleOfferProps {
  readonly client: RuleClient;
  readonly signIn: SignInSummary['id'];
  readonly askPasskey: RulesBinding['askPasskey'];
}

interface Found {
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
}

export function SignInRuleOffer({ client, signIn, askPasskey }: SignInRuleOfferProps) {
  const [found, setFound] = useState<Found | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  if (saved)
    return (
      <p className="m-0 text-meta text-ok" data-rule-offer-saved="" role="status">
        Standing rule saved. You can narrow or revoke it in Settings.
      </p>
    );

  if (found !== undefined)
    return (
      <SignInRuleSheetHost
        accountName={found.account.label}
        autoRecipe={found.signIn.autoApplyRecipe === true}
        codeAvailable={found.account.fields.totp}
        onCancel={() => setFound(undefined)}
        onSettled={() => {
          setFound(undefined);
          setSaved(true);
        }}
        origin="owner"
        place={found.signIn.place}
        rules={{ client, askPasskey }}
        signIn={found.signIn.id}
        {...(found.account.username === undefined ? {} : { username: found.account.username })}
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-1" data-rule-offer="">
      <button
        className="kt-btn min-h-[44px] self-start"
        data-rule-offer-button=""
        disabled={reading}
        onClick={() => {
          setReading(true);
          setFailure(undefined);
          void readAccounts(client).then(
            list => {
              const picked = list.signIns.find(each => each.id === signIn);
              const account = picked === undefined ? undefined : list.accounts.find(each => each.id === picked.account);
              setReading(false);
              if (picked === undefined || account === undefined) setFailure('That sign-in is no longer saved.');
              else setFound({ signIn: picked, account });
            },
            cause => {
              setReading(false);
              setFailure(isForbidden(cause) ? RULE_NO_ACCOUNTS_DEVICE_WORDS : failureWords(cause));
            },
          );
        }}
        type="button"
      >
        Don’t ask again for this sign-in…
      </button>
      <p className="m-0 text-meta text-muted">
        Opens a sheet. Nothing is approved until you choose and use your passkey.
      </p>
      {failure === undefined ? null : (
        <p className="m-0 text-meta text-err" data-rule-failure="" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
