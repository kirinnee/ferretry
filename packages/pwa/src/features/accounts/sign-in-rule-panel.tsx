/**
 * A sign-in's STANDING RULE tab, and the sheet host both it and a ferret's suggestion open. Names (the account, the
 * username) are the ones this owner screen already read from the secrets-gated accounts route; the rule list is read from
 * the secrets-gated rule route, and a device that may not use secrets sees one clear sentence, never names.
 */

import type {
  AccountSummary,
  Place,
  SignInRuleEligibility,
  SignInRuleId,
  SignInRuleScope,
  SignInRuleView,
  SignInSummary,
} from '@ferretry/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import {
  codeKeyLabel,
  draftOf,
  failureWords,
  readEligibility,
  RULE_DAMAGED_WORDS,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  type RuleOrigin,
  revokeRule,
  narrowRule,
  runRuleApproval,
  suspendableRules,
  suspendWarning,
} from '../../lib/sign-in-rules.ts';
import { SignInRuleCard } from './sign-in-rule-card.tsx';
import { type RuleSheetPhase, SignInRuleSheet } from './sign-in-rule-sheet.tsx';
import { type RulesBinding, useSignInRules } from './use-sign-in-rules.ts';

export interface SignInRuleSheetHostProps {
  readonly rules: RulesBinding;
  readonly signIn: SignInSummary['id'];
  readonly accountName: string;
  readonly username?: string;
  readonly place: Place;
  readonly origin: RuleOrigin;
  readonly before?: SignInRuleView;
  readonly replaces?: SignInRuleId;
  readonly codeAvailable: boolean;
  /** The label of the 2FA key a ticked code would use. */
  readonly codeKey?: string | undefined;
  readonly autoRecipe: boolean;
  readonly scopes?: readonly SignInRuleScope[];
  readonly onSettled: (rule: SignInRuleView) => void;
  readonly onCancel: () => void;
}

/** The sheet, wired: asks the daemon whether the sign-in is eligible, then stages, asks the passkey and commits. */
export function SignInRuleSheetHost(props: SignInRuleSheetHostProps): ReactNode {
  const { rules, signIn } = props;
  const [eligibility, setEligibility] = useState<SignInRuleEligibility | undefined>(undefined);
  const [phase, setPhase] = useState<RuleSheetPhase>({ kind: 'idle' });

  useEffect(() => {
    let current = true;
    void readEligibility(rules.client, signIn).then(
      found => {
        if (current) setEligibility(found);
      },
      cause => {
        if (current) setPhase({ kind: 'failed', words: failureWords(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [rules.client, signIn]);

  return (
    <SignInRuleSheet
      accountName={props.accountName}
      autoRecipe={props.autoRecipe}
      canUsePasskey={rules.askPasskey !== undefined}
      codeAvailable={props.codeAvailable}
      codeKey={props.codeKey}
      eligibility={eligibility}
      onApprove={ticks =>
        void runRuleApproval(
          {
            client: rules.client,
            askPasskey: rules.askPasskey,
            report: progress => setPhase({ kind: 'working', progress }),
          },
          draftOf(signIn, ticks, props.replaces),
        ).then(outcome => {
          if (outcome.kind === 'settled') props.onSettled(outcome.rule);
          else if (outcome.kind === 'dismissed') setPhase({ kind: 'dismissed' });
          else setPhase({ kind: 'failed', words: outcome.words });
        })
      }
      onCancel={props.onCancel}
      origin={props.origin}
      phase={phase}
      place={props.place}
      scopes={props.scopes ?? [{ kind: 'any' }]}
      {...(props.before === undefined ? {} : { before: props.before })}
      {...(props.username === undefined ? {} : { username: props.username })}
    />
  );
}

export interface SignInRulePanelProps {
  readonly rules: RulesBinding;
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
}

/** The sign-in's Rule tab: its rule if it has one, otherwise the way to make one. */
export function SignInRulePanel({ rules, signIn, account }: SignInRulePanelProps): ReactNode {
  const { read, reload } = useSignInRules(rules.client);
  const [sheet, setSheet] = useState<{ readonly origin: RuleOrigin; readonly before?: SignInRuleView } | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  if (read.kind === 'loading')
    return (
      <p className="m-0 text-ui text-muted" data-rule-panel="loading" role="status">
        Reading the standing rules…
      </p>
    );
  if (read.kind === 'forbidden')
    return (
      <p className="m-0 text-ui text-warn" data-rule-panel="forbidden" role="status">
        {RULE_NO_ACCOUNTS_DEVICE_WORDS}
      </p>
    );
  if (read.kind === 'failed')
    return (
      <p className="m-0 text-ui text-err" data-rule-panel="failed" role="alert">
        {read.words}
      </p>
    );

  const rule = read.list.rules.find(each => each.signIn === signIn.id);
  const finish = (): void => {
    setSheet(undefined);
    reload();
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-panel="rule" data-rule-panel="ready">
      {read.list.health === 'damaged' ? (
        <p className="m-0 text-ui text-err" data-rule-damaged="" role="alert">
          {RULE_DAMAGED_WORDS}
        </p>
      ) : null}
      {sheet !== undefined ? (
        <SignInRuleSheetHost
          accountName={account.label}
          autoRecipe={signIn.autoApplyRecipe === true}
          codeAvailable={account.fields.totp}
          codeKey={codeKeyLabel(account.factors)}
          onCancel={() => setSheet(undefined)}
          onSettled={finish}
          origin={sheet.origin}
          place={signIn.place}
          rules={rules}
          signIn={signIn.id}
          {...(rule === undefined ? {} : { replaces: rule.id })}
          {...(sheet.before === undefined ? {} : { before: sheet.before })}
          {...(account.username === undefined ? {} : { username: account.username })}
        />
      ) : rule !== undefined ? (
        <SignInRuleCard
          busy={busy}
          canUsePasskey={rules.askPasskey !== undefined}
          failure={failure}
          onNarrow={narrow => {
            setBusy(true);
            setFailure(undefined);
            void narrowRule(rules.client, rule.id, narrow).then(
              () => {
                setBusy(false);
                reload();
              },
              cause => {
                setBusy(false);
                setFailure(failureWords(cause));
              },
            );
          }}
          onReapprove={origin => setSheet({ origin, before: rule })}
          onRevoke={() => {
            setBusy(true);
            setFailure(undefined);
            void revokeRule(rules.client, rule.id).then(
              () => {
                setBusy(false);
                reload();
              },
              cause => {
                setBusy(false);
                setFailure(failureWords(cause));
              },
            );
          }}
          rule={rule}
        />
      ) : (
        <>
          <p className="m-0 text-cell text-muted" data-rule-none="">
            No standing rule. Ferrets ask you each time this sign-in is used.
          </p>
          <div>
            <button
              className="kt-btn min-h-[44px]"
              data-rule-start=""
              data-variant="primary"
              onClick={() => setSheet({ origin: 'owner' })}
              type="button"
            >
              Don’t ask again for this sign-in…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Shown on the Method and Recipe tabs: a save here suspends the sign-in's standing rule, because a rule is pinned to the
 * sign-in as the owner approved it. Drawn only when the daemon lists such a rule.
 */
export function RuleEditWarning({
  rules,
  signIn,
}: {
  readonly rules: RulesBinding;
  readonly signIn: SignInSummary['id'];
}) {
  const { read } = useSignInRules(rules.client);
  if (read.kind !== 'ready') return null;
  const count = suspendableRules(read.list.rules, signIn).length;
  if (count === 0) return null;
  return (
    <p className="m-0 text-meta text-warn" data-rule-edit-warning="" role="status">
      {suspendWarning(count)}
    </p>
  );
}
