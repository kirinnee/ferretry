/**
 * The quiet offer after the owner hand-tapped a saved sign-in on an input card: "Don’t ask again for this sign-in…".
 * It only opens the owner's own sheet with nothing ticked; no rule exists until the owner approves it with a passkey.
 * The names come from the secrets-gated accounts route, read when the owner opens the sheet. It is offered ONLY once the
 * daemon says this sign-in is eligible: while that is read, when it is not eligible, and when the machine cannot answer,
 * nothing is drawn, so the offer never leads to a sheet that says no.
 */

import type { AccountSummary, SignInSummary } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import { readAccounts } from '../../lib/input-api.ts';
import {
  codeKeyLabel,
  failureWords,
  isForbidden,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  type RuleClient,
  readEligibility,
} from '../../lib/sign-in-rules.ts';
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
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    let current = true;
    setEligible(false);
    void readEligibility(client, signIn).then(
      answer => {
        if (current) setEligible(answer.eligible);
      },
      () => {
        if (current) setEligible(false);
      },
    );
    return () => {
      current = false;
    };
  }, [client, signIn]);

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
        codeKey={codeKeyLabel(found.account.factors)}
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

  if (!eligible) return null;

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
