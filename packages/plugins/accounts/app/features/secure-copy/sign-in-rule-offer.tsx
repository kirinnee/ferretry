/**
 * "DON'T ASK AGAIN" AFTER A SAVED SIGN-IN: what Accounts draws in the Vault's `vault.input-settled` slot, under an input
 * card the owner just settled by tapping a saved account.
 *
 * It is only a way to open the owner's own sheet (`SignInRuleSheetHost`, origin `offer`); it approves nothing itself. The
 * standing rule is written by the same stage → passkey → commit path as every other rule, so a tap here can never widen
 * what Ferretry may type on its own.
 *
 * What the Vault hands over is ids the card already held (the ferret, the account's handle, the sign-in the tap used):
 * never a value, and none of it is believed past what the DAEMON says. The account, the sign-in and the place the rule
 * would pin are READ from the secrets-gated accounts route, and the offer is drawn only when that sign-in belongs to that
 * very account. A tap that named no sign-in, a sign-in this machine no longer has, an account it does not match, a
 * device that may not read accounts and a read that failed all draw NOTHING: the offer is a convenience, and the card is
 * complete without it.
 */

import { isInputSettledSlotProps } from '@ferretry/core-vault/contract';
import type { AccountSummary, SignInRuleScope, SignInSummary } from '../../../contract/routes/index.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readAccounts } from '../accounts/accounts-api.ts';
import { ConfirmToSee } from '../confirm-to-see.tsx';
import { SignInRuleSheetHost } from '../accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';
import { codeKeyLabel, readFerretProject, type RuleClient } from '../../lib/sign-in-rules.ts';
import { isStepUpRefusal } from '../../lib/step-up-refusal.ts';

export interface SignInRuleOfferProps {
  /** The Accounts client of the machine the card is on. */
  readonly client: RuleClient;
  /** What the slot handed the panel: the shell's `subject` and the card's props, none of them trusted. */
  readonly slot: unknown;
  /** Asks for the passkey bound to the stage; absent where this device cannot ask. */
  readonly askPasskey?: RulesBinding['askPasskey'];
}

interface Found {
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
}

type Offer = 'idle' | 'sheet' | 'done';

export function SignInRuleOffer({ client, slot, askPasskey }: SignInRuleOfferProps) {
  const props = isInputSettledSlotProps(slot) ? slot : undefined;
  const ferret = props?.ferret;
  const entry = props?.entry;
  const signInId = props?.signIn;
  const [found, setFound] = useState<Found | undefined>(undefined);
  const [project, setProject] = useState<string | undefined>(undefined);
  const [offer, setOffer] = useState<Offer>('idle');
  /** The daemon wants the owner's step-up to list the accounts; the quiet read did not ask for it. */
  const [locked, setLocked] = useState(false);
  const [presses, setPresses] = useState(0);
  /** Set by the owner's press on "Confirm it's you": the next read is theirs, so it may ask for the passkey. */
  const pressed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `presses` re-runs the read when the owner confirms
  useEffect(() => {
    setFound(undefined);
    setOffer('idle');
    setLocked(false);
    // No sign-in named: the tap used none, so there is nothing a rule could be for. Nothing is read.
    if (entry === undefined || signInId === undefined) return;
    let current = true;
    // Mounting under a settled card is the page's own work, not the owner acting: quiet unless they pressed for it.
    const quiet = !pressed.current;
    pressed.current = false;
    void readAccounts(client, { quiet }).then(
      list => {
        if (!current) return;
        const signIn = list.signIns.find(each => each.id === signInId);
        // The sign-in must belong to the account the tap used: a mismatched pair is never offered.
        const account = signIn === undefined ? undefined : list.accounts.find(each => each.id === signIn.account);
        if (signIn !== undefined && account !== undefined && account.id === entry) setFound({ signIn, account });
      },
      (cause: unknown) => {
        if (current && isStepUpRefusal(cause)) setLocked(true);
      },
    );
    return () => {
      current = false;
    };
  }, [client, entry, signInId, presses]);

  // The asking ferret's board project, read from its record: the owner may limit the rule to it. When it cannot be read
  // the choice is simply not offered (a read never widens anything).
  useEffect(() => {
    setProject(undefined);
    if (ferret === undefined) return;
    let current = true;
    void readFerretProject(client, ferret).then(read => {
      if (current) setProject(read);
    });
    return () => {
      current = false;
    };
  }, [client, ferret]);

  const scopes = useMemo<readonly SignInRuleScope[]>(
    () => [
      { kind: 'any' },
      ...(ferret === undefined ? [] : [{ kind: 'session' as const, session: ferret }]),
      ...(project === undefined ? [] : [{ kind: 'project' as const, project }]),
    ],
    [ferret, project],
  );

  if (locked)
    return (
      <ConfirmToSee
        onConfirm={() => {
          pressed.current = true;
          setPresses(count => count + 1);
        }}
      />
    );
  if (found === undefined) return null;
  const { signIn, account } = found;

  if (offer === 'done')
    return (
      <p className="m-0 text-cell text-muted" data-rule-offer="done" role="status">
        Done. Ferretry will not ask again for {account.label} here, until the rule ends.
      </p>
    );

  if (offer === 'sheet')
    return (
      <div data-rule-offer="sheet">
        <SignInRuleSheetHost
          accountName={account.label}
          autoRecipe={signIn.autoApplyRecipe === true}
          codeAvailable={account.factors.some(key => key.automatic)}
          codeKey={codeKeyLabel(account.factors)}
          onCancel={() => setOffer('idle')}
          onSettled={() => setOffer('done')}
          origin="offer"
          place={signIn.place}
          rules={{ client, askPasskey }}
          scopes={scopes}
          signIn={signIn.id}
          {...(account.username === undefined ? {} : { username: account.username })}
        />
      </div>
    );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-rule-offer="idle">
      <button className="kt-btn min-h-[44px]" data-rule-offer-open="" onClick={() => setOffer('sheet')} type="button">
        Don’t ask again…
      </button>
    </div>
  );
}
