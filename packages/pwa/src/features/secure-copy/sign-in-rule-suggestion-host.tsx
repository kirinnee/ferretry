/**
 * A ferret's SUGGESTION of a standing sign-in rule (`signInRuleSuggestion` on an agenda item), fetched and kept honest.
 * The card is drawn ONLY from that daemon-set ref: a ferret's plain item with the same words draws plain. A suggestion is
 * only a way to open the owner's own sheet, with NOTHING ticked: it holds no stage, no proof and no fields. The names (the
 * account, the username) come from the secrets-gated accounts route, never from the item's text; the ferret's reason is
 * shown faint and quoted, as the ferret's.
 *
 * ANSWERED ON THE OWNER'S SIDE ONLY (R1, C2): a Dismiss or an approved rule never closes the card, which the ferret reads
 * on its own agenda until it expires. It marks the suggestion answered in the app's set, which takes it out of the
 * Inbox; so does a suggestion the daemon's owner list no longer holds.
 */

import {
  type AccountSummary,
  type AgendaItem,
  DAEMON_FEATURES,
  type SignInRuleSuggestionView,
  type SignInSummary,
} from '@ferretry/protocol';
import { useEffect, useMemo, useState } from 'react';
import { type AnsweredSuggestions, answeredSuggestions } from '../../lib/answered-suggestions.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineOffers } from '../../lib/daemon-health.ts';
import { readAccounts } from '../../lib/input-api.ts';
import {
  codeKeyLabel,
  dismissSuggestion,
  failureWords,
  isForbidden,
  listSuggestions,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  type RuleClient,
} from '../../lib/sign-in-rules.ts';
import { useApproveSignInRuleStepUp, useDaemonClient } from '../../lib/store.tsx';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { SignInRuleSheetHost } from '../accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';

export interface SignInRuleSuggestionHostProps {
  readonly connection: DaemonConnection;
  readonly item: Pick<AgendaItem, 'signInRuleSuggestion'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<RuleClient>;
  /** Asks for the passkey bound to the stage, in place of the store's step-up (the harness and tests). */
  readonly askPasskey?: RulesBinding['askPasskey'];
  /** Says the machine offers `sign-in-rules.1` without reading its health (the harness and tests). */
  readonly offered?: boolean;
  readonly onDone?: () => void;
  /** The set an answer is marked in, in place of the app's (the tests). */
  readonly answered?: AnsweredSuggestions;
}

interface Found {
  readonly client: RuleClient;
  readonly suggestion: SignInRuleSuggestionView;
  readonly signIn: SignInSummary | undefined;
  readonly account: AccountSummary | undefined;
}

export function SignInRuleSuggestionHost({
  connection,
  item,
  agentName,
  createClient: injected,
  askPasskey: injectedAsk,
  offered: injectedOffered,
  onDone,
  answered = answeredSuggestions,
}: SignInRuleSuggestionHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const health = useDaemonHealth(injectedOffered === undefined ? connection : undefined);
  const askStage = useApproveSignInRuleStepUp();
  const offered = injectedOffered ?? machineOffers(health, DAEMON_FEATURES.signInRules);
  const suggestionId = item.signInRuleSuggestion?.suggestion;

  const askPasskey = useMemo<RulesBinding['askPasskey']>(
    () => injectedAsk ?? (askStage === undefined ? undefined : (stage, words) => askStage(connection, stage, words)),
    [askStage, connection, injectedAsk],
  );

  const [found, setFound] = useState<Found | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!offered || suggestionId === undefined) return undefined;
    let current = true;
    setForbidden(false);
    void createClient(connection)
      .then(async client => {
        const { suggestions } = await listSuggestions(client);
        const suggestion = suggestions.find(each => each.id === suggestionId);
        // Not on the owner's list: answered (here or on another device) or expired. Either way, out of the Inbox.
        if (suggestion === undefined) {
          answered.mark(connection.daemonId, [suggestionId]);
          return undefined;
        }
        const accounts = await readAccounts(client);
        const signIn = accounts.signIns.find(each => each.id === suggestion.signIn);
        const account = signIn === undefined ? undefined : accounts.accounts.find(each => each.id === signIn.account);
        return { client, suggestion, signIn, account } satisfies Found;
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
  }, [offered, connection, createClient, suggestionId, answered]);

  if (suggestionId === undefined || !offered) return null;
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

  const { client, suggestion, signIn, account } = found;
  const ferret = agentName ?? 'The ferret';

  if (sheet && signIn !== undefined && account !== undefined)
    return (
      <SignInRuleSheetHost
        accountName={account.label}
        autoRecipe={signIn.autoApplyRecipe === true}
        codeAvailable={account.fields.totp}
        codeKey={codeKeyLabel(account.factors)}
        onCancel={() => setSheet(false)}
        onSettled={() => {
          setSheet(false);
          answered.mark(connection.daemonId, [suggestion.id]);
          onDone?.();
        }}
        origin="suggestion"
        place={signIn.place}
        rules={{ client, askPasskey }}
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
              () => {
                answered.mark(connection.daemonId, [suggestion.id]);
                onDone?.();
              },
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
