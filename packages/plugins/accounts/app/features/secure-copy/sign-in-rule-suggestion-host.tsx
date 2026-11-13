/**
 * A ferret's SUGGESTION of a standing sign-in rule (`rule-suggestion` on an ask), fetched and kept honest. The card is
 * drawn ONLY from that daemon-set ref: a ferret's plain ask with the same words draws plain. A suggestion is only a way
 * to open the owner's own sheet, with NOTHING ticked: it holds no stage, no proof and no fields. The names (the
 * account, the username) come from the secrets-gated accounts route, never from the ask's text; the ferret's reason is
 * shown faint and quoted, as the ferret's. The daemon closes the ask when the suggestion is answered or expires.
 */

import type {
  AccountSummary,
  SignInRuleScope,
  SignInRuleSuggestionView,
  SignInSummary,
} from '../../../contract/routes/index.ts';
import { useEffect, useMemo, useState } from 'react';
import { readAccounts } from '../accounts/accounts-api.ts';
import {
  codeKeyLabel,
  dismissSuggestion,
  failureWords,
  isForbidden,
  listSuggestions,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  type RuleClient,
} from '../../lib/sign-in-rules.ts';
import { SignInRuleSheetHost } from '../accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';

export interface SignInRuleSuggestionHostProps {
  /** The Accounts client of the machine the ask is on. */
  readonly client: RuleClient;
  readonly suggestionId: string;
  readonly agentName?: string;
  /** The ferret that asked: the owner may limit the rule to it. */
  readonly ferret?: string;
  /** Asks for the passkey bound to the stage; absent where this device cannot ask. */
  readonly askPasskey?: RulesBinding['askPasskey'];
  readonly onDone?: () => void;
}

interface Found {
  readonly suggestion: SignInRuleSuggestionView;
  readonly signIn: SignInSummary | undefined;
  readonly account: AccountSummary | undefined;
}

export function SignInRuleSuggestionHost({
  client,
  suggestionId,
  agentName,
  ferret: asking,
  askPasskey,
  onDone,
}: SignInRuleSuggestionHostProps) {
  const scopes = useMemo<readonly SignInRuleScope[]>(
    () => [{ kind: 'any' }, ...(asking === undefined ? [] : [{ kind: 'session' as const, session: asking }])],
    [asking],
  );
  const [found, setFound] = useState<Found | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setForbidden(false);
    void listSuggestions(client)
      .then(async ({ suggestions }) => {
        const suggestion = suggestions.find(each => each.id === suggestionId);
        // Not on the owner's list: answered (here or on another device) or expired: nothing to draw.
        if (suggestion === undefined) return undefined;
        const accounts = await readAccounts(client);
        const signIn = accounts.signIns.find(each => each.id === suggestion.signIn);
        const account = signIn === undefined ? undefined : accounts.accounts.find(each => each.id === signIn.account);
        return { suggestion, signIn, account } satisfies Found;
      })
      .then(
        next => {
          if (current && next !== undefined) setFound(next);
        },
        cause => {
          // A device that can't see accounts is refused every time: say so once and stop asking.
          if (!current) return;
          if (isForbidden(cause)) setForbidden(true);
          else setFailure(failureWords(cause));
        },
      );
    return () => {
      current = false;
    };
  }, [client, suggestionId]);

  if (forbidden)
    return (
      <p className="m-0 text-ui text-warn" data-rule-suggestion-forbidden="" role="status">
        {RULE_NO_ACCOUNTS_DEVICE_WORDS}
      </p>
    );
  if (found === null)
    return failure === undefined ? null : (
      <p className="m-0 text-ui text-err" data-rule-failure="" role="alert">
        {failure}
      </p>
    );

  const { suggestion, signIn, account } = found;
  const ferret = agentName ?? 'The ferret';

  if (sheet && signIn !== undefined && account !== undefined)
    return (
      <SignInRuleSheetHost
        accountName={account.label}
        autoRecipe={signIn.autoApplyRecipe === true}
        codeAvailable={account.factors.some(key => key.automatic)}
        codeKey={codeKeyLabel(account.factors)}
        onCancel={() => setSheet(false)}
        onSettled={() => {
          setSheet(false);
          onDone?.();
        }}
        origin="suggestion"
        place={signIn.place}
        rules={{ client, askPasskey }}
        scopes={scopes}
        signIn={signIn.id}
        {...(account.username === undefined ? {} : { username: account.username })}
      />
    );

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-rule-suggestion={suggestion.id}
      data-rule-suggestion-surface={suggestion.surface}
    >
      <p className="m-0 min-w-0 break-words text-ui text-fg" data-rule-suggestion-subject="">
        {signIn === undefined || account === undefined
          ? 'That sign-in is no longer saved.'
          : `${ferret} suggests a standing rule for ${account.label} on ${suggestion.host}.`}
      </p>
      <span className="text-meta text-faint" data-rule-suggestion-why="">
        {ferret} says: “{suggestion.why}”
      </span>
      <p className="m-0 text-cell text-muted">
        Nothing is ticked and nothing is approved. You choose what Ferretry may type, and for how long.
      </p>
      {failure === undefined ? null : (
        <p className="m-0 text-ui text-err" data-rule-failure="" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2" data-rule-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-rule-suggestion-dismiss=""
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void dismissSuggestion(client, suggestion.id).then(
              () => onDone?.(),
              cause => {
                setBusy(false);
                setFailure(failureWords(cause));
              },
            );
          }}
          type="button"
        >
          Dismiss
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-rule-suggestion-review=""
          data-variant="primary"
          disabled={busy || signIn === undefined || account === undefined}
          onClick={() => setSheet(true)}
          type="button"
        >
          Review the rule…
        </button>
      </div>
    </div>
  );
}
