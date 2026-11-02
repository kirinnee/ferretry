/**
 * ONE ACCOUNT: Details (username, a write-only password), 2FA keys and Sign-ins.
 *
 * Nothing here can show a value. The password box is a fresh empty field every time and the page only says whether one
 * is saved; a 2FA key is listed by its label and plain facts. A seed is set up by the SAME panel the code card uses,
 * so the passkey that binds the save is asked in one place only.
 */

import {
  type AccountId,
  type AccountSummary,
  type AddTwoFactorKeyRequest,
  PUSH_APPS,
  type PushApp,
  type SignInSummary,
  type TwoFactorKeySummary,
  type TwoFactorKind,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  accountTitle,
  KEY_KIND_OPTIONS,
  keyFacts,
  keyKindWords,
  keyState,
  keyStateWords,
  PUSH_APP_WORDS,
  placeTitle,
  signInMethodWords,
  smsDigits,
} from '../../lib/accounts-screen.ts';
import type { CodesAccount } from '../../lib/automatic-codes.ts';
import type { InputClient } from '../../lib/input-api.ts';
import { methodOfDraft, parseDomains, passwordProblem, type SignInDraft, signInProblem } from '../../lib/login-form.ts';
import { AutomaticCodesPanel } from '../input-request/automatic-codes.tsx';
import { type AccountOps, INPUT, Refusal, Tabs } from './accounts-parts.tsx';
import { AccountRulesRevoke } from './account-rules.tsx';
import { MethodFields } from './method-fields.tsx';
import type { RulesBinding } from './use-sign-in-rules.ts';

export type AccountTab = 'details' | 'keys' | 'sites';

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'keys', label: '2FA keys' },
  { id: 'sites', label: 'Sign-ins' },
] as const;

export interface AccountDetailProps {
  readonly account: AccountSummary;
  readonly accounts: readonly AccountSummary[];
  readonly signIns: readonly SignInSummary[];
  readonly ops: AccountOps;
  readonly busy: boolean;
  readonly error: string | null;
  readonly client: InputClient;
  /** Standing sign-in rules, when this machine reports them. */
  readonly rules?: RulesBinding | undefined;
  /** Asks for the passkey bound to a staged seed; absent outside the app, where no seed can be saved. */
  readonly addKey: ((stage: TwoFactorStageId, words: string) => Promise<boolean>) | undefined;
  /** False on a machine without 2FA keys: the tab is not offered. */
  readonly withKeys: boolean;
  readonly tab: AccountTab;
  readonly onTab: (tab: AccountTab) => void;
  readonly onOpenSite: (signIn: SignInSummary) => void;
  readonly onSaved: () => void;
  readonly onClosed: () => void;
}

export function AccountDetail(props: AccountDetailProps): ReactNode {
  const { account, tab, onTab, withKeys } = props;
  return (
    <section
      aria-label={`Account ${account.label}`}
      className="flex min-w-0 flex-col gap-3"
      data-accounts-account={account.id}
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 min-w-0 break-words text-row font-semibold text-fg">{accountTitle(account)}</h3>
        <p className="m-0 min-w-0 break-words text-meta text-faint" data-accounts-cli-name="">
          Name in the terminal <span className="mono">{account.id}</span> · how <span className="mono">fy account</span>{' '}
          names it, not an environment variable
        </p>
      </header>
      <Tabs
        label={`${account.label} sections`}
        onSelect={onTab}
        selected={tab}
        tabs={withKeys ? TABS : TABS.filter(each => each.id !== 'keys')}
      />
      {tab === 'details' ? <DetailsTab {...props} /> : null}
      {tab === 'keys' && withKeys ? <KeysTab {...props} /> : null}
      {tab === 'sites' ? <SitesTab {...props} /> : null}
    </section>
  );
}

function DetailsTab({ account, ops, busy, error, onClosed, rules }: AccountDetailProps): ReactNode {
  const [label, setLabel] = useState(account.label);
  const [username, setUsername] = useState(account.username ?? '');
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const problem = passwordProblem(password);
  const changed = label.trim() !== account.label || username.trim() !== (account.username ?? '') || password !== '';

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!changed || problem !== undefined || label.trim() === '' || busy) return;
    const took = await ops.putAccount(account.id, {
      ...(label.trim() === account.label ? {} : { label: label.trim() }),
      ...(username.trim() === (account.username ?? '')
        ? {}
        : { username: username.trim() === '' ? null : username.trim() }),
      ...(password === '' ? {} : { password }),
    });
    if (took) setPassword('');
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form className="flex min-w-0 flex-col gap-3" data-accounts-panel="details" onSubmit={event => void save(event)}>
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          Name
          <input
            className={INPUT}
            data-accounts-label=""
            disabled={busy}
            onChange={event => setLabel(event.target.value)}
            value={label}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          Username
          <input
            autoCapitalize="off"
            autoComplete="off"
            className={INPUT}
            data-accounts-username=""
            disabled={busy}
            onChange={event => setUsername(event.target.value)}
            spellCheck={false}
            value={username}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          {account.fields.password ? 'Replace the password' : 'Password'}
          <input
            autoComplete="new-password"
            className={INPUT}
            data-1p-ignore=""
            data-accounts-password=""
            data-lpignore="true"
            disabled={busy}
            onChange={event => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <span className="text-meta font-normal text-muted" data-accounts-password-state="">
            {account.fields.password
              ? 'A password is saved. It is write-only: nobody can read it back, ferrets included.'
              : 'No password saved.'}
          </span>
          {problem === undefined ? null : <span className="text-meta font-normal text-err">{problem}</span>}
        </label>
        <Refusal error={error} />
        <div className="flex flex-wrap gap-2">
          <button
            className="kt-btn min-h-[44px]"
            data-accounts-save=""
            data-variant="primary"
            disabled={!changed || problem !== undefined || label.trim() === '' || busy}
            type="submit"
          >
            Save
          </button>
          {confirming ? (
            <>
              <button
                className="kt-btn min-h-[44px]"
                data-accounts-confirm-remove=""
                data-variant="danger"
                disabled={busy}
                onClick={() => void ops.removeAccount(account.id).then(took => took && onClosed())}
                type="button"
              >
                Remove {account.label} and its sign-ins
              </button>
              <button className="kt-btn min-h-[44px]" onClick={() => setConfirming(false)} type="button">
                Keep it
              </button>
            </>
          ) : (
            <button
              aria-label={`Remove account ${account.label}`}
              className="kt-btn min-h-[44px]"
              data-accounts-remove=""
              data-variant="danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} /> Remove account
            </button>
          )}
        </div>
      </form>
      {rules === undefined ? null : <AccountRulesRevoke account={account} rules={rules} />}
    </div>
  );
}

// ── 2FA keys ──────────────────────────────────────────────────────────────────────────────────────────

const STATE_TONE = { worked: 'text-muted', unused: 'text-muted', failed: 'text-err' } as const;

function KeysTab({ account, signIns, ops, busy, error, client, addKey, onSaved }: AccountDetailProps): ReactNode {
  const codesAccount: CodesAccount = {
    id: account.id,
    label: account.label,
    ...(account.username === undefined ? {} : { username: account.username }),
    places: signIns.map(signIn => signIn.place),
    seeds: account.factors.filter(key => key.automatic).length,
  };
  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-panel="keys">
      {account.factors.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-accounts-keys-empty="">
          No 2FA keys yet. Add the ways this account asks for a second step.
        </p>
      ) : (
        <ul aria-label="2FA keys" className="m-0 flex list-none flex-col gap-2 p-0">
          {account.factors.map(key => (
            <KeyRow key={key.id} accountId={account.id} busy={busy} keyOf={key} ops={ops} />
          ))}
        </ul>
      )}
      <Refusal error={error} />
      {addKey === undefined ? (
        <p className="m-0 text-cell text-muted" data-accounts-codes-unavailable="">
          Automatic codes are saved from the app, with a passkey.
        </p>
      ) : (
        <AutomaticCodesPanel
          accounts={[codesAccount]}
          addKey={addKey}
          client={client}
          defaultOpen={false}
          initial={codesAccount}
          onSaved={onSaved}
        />
      )}
      <AddKeyForm accountId={account.id} busy={busy} ops={ops} />
    </div>
  );
}

function KeyRow({
  accountId,
  keyOf,
  ops,
  busy,
}: {
  readonly accountId: AccountId;
  readonly keyOf: TwoFactorKeySummary;
  readonly ops: AccountOps;
  readonly busy: boolean;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const state = keyState(keyOf);
  const stateWords = keyStateWords(keyOf);
  return (
    <li
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-surface p-2"
      data-accounts-key={keyOf.id}
      {...(state === undefined ? {} : { 'data-accounts-key-state': state })}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 min-w-0 break-words text-ui font-medium text-fg">{keyOf.label}</p>
          <p className="m-0 text-meta text-muted">
            {keyKindWords(keyOf.kind)} · {keyFacts(keyOf)}
          </p>
          {state === undefined || stateWords === undefined ? null : (
            <p className={`m-0 text-meta ${STATE_TONE[state]}`} data-accounts-key-words="">
              {stateWords}
            </p>
          )}
        </div>
        {confirming ? null : (
          <button
            aria-label={`Remove 2FA key ${keyOf.label}`}
            className="kt-btn min-h-[44px]"
            data-accounts-key-remove=""
            data-variant="danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />
          </button>
        )}
      </div>
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="kt-btn min-h-[44px]"
            data-accounts-key-confirm=""
            data-variant="danger"
            disabled={busy}
            onClick={() => void ops.removeKey(accountId, keyOf.id).then(() => setConfirming(false))}
            type="button"
          >
            Remove {keyOf.label}
            {keyOf.automatic ? ' and its saved key' : ''}
          </button>
          <button className="kt-btn min-h-[44px]" onClick={() => setConfirming(false)} type="button">
            Keep it
          </button>
        </div>
      ) : null}
    </li>
  );
}

function AddKeyForm({
  accountId,
  ops,
  busy,
}: {
  readonly accountId: AccountId;
  readonly ops: AccountOps;
  readonly busy: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Exclude<TwoFactorKind, 'totp'>>('sms');
  const [label, setLabel] = useState('');
  const [fact, setFact] = useState('');
  const [app, setApp] = useState<PushApp | ''>('');
  const digits = kind === 'sms' && fact.trim() !== '' ? smsDigits(fact) : undefined;
  const problem =
    kind === 'sms' && fact.trim() !== '' && digits === undefined ? 'Only the last 2 to 4 digits, like 42.' : undefined;

  const body = (): AddTwoFactorKeyRequest | undefined => {
    const name = label.trim();
    if (name === '') return undefined;
    if (kind === 'sms') return { kind, label: name, ...(digits === undefined ? {} : { endsWith: digits }) };
    if (kind === 'email') return { kind, label: name, ...(fact.trim() === '' ? {} : { to: fact.trim() }) };
    if (kind === 'push') return { kind, label: name, ...(app === '' ? {} : { app }) };
    return { kind, label: name };
  };

  if (!open)
    return (
      <div>
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-key-add-open=""
          onClick={() => setOpen(true)}
          type="button"
        >
          <Plus aria-hidden="true" size={14} /> Add another way
        </button>
      </div>
    );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const next = body();
    if (next === undefined || problem !== undefined || busy) return;
    if (await ops.addKey(accountId, next)) {
      setLabel('');
      setFact('');
      setApp('');
      setOpen(false);
    }
  };

  return (
    <form
      aria-label="Add a 2FA key"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3"
      data-accounts-key-form=""
      onSubmit={event => void submit(event)}
    >
      <p className="m-0 text-cell text-muted">
        This only writes down WHICH way the site asks, so a card can say so. It holds no code and no key.
      </p>
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Kind
        <select
          className={INPUT}
          data-accounts-key-kind=""
          disabled={busy}
          onChange={event => {
            setKind(event.target.value as Exclude<TwoFactorKind, 'totp'>);
            setFact('');
          }}
          value={kind}
        >
          {KEY_KIND_OPTIONS.map(option => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Name
        <input
          className={INPUT}
          data-accounts-key-label=""
          disabled={busy}
          maxLength={60}
          onChange={event => setLabel(event.target.value)}
          placeholder="Work phone"
          value={label}
        />
      </label>
      {kind === 'sms' || kind === 'email' ? (
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          {kind === 'sms' ? 'Last digits of the number (optional)' : 'Where the code arrives (optional)'}
          <input
            autoComplete="off"
            className={INPUT}
            data-accounts-key-fact=""
            disabled={busy}
            inputMode={kind === 'sms' ? 'numeric' : 'email'}
            onChange={event => setFact(event.target.value)}
            value={fact}
          />
          {problem === undefined ? null : <span className="text-meta font-normal text-err">{problem}</span>}
        </label>
      ) : null}
      {kind === 'push' ? (
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          Which app (optional)
          <select
            className={INPUT}
            data-accounts-key-app=""
            disabled={busy}
            onChange={event => setApp(event.target.value as PushApp | '')}
            value={app}
          >
            <option value="">Not said</option>
            {PUSH_APPS.map(each => (
              <option key={each} value={each}>
                {PUSH_APP_WORDS[each]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-key-add=""
          data-variant="primary"
          disabled={busy || label.trim() === '' || problem !== undefined}
          type="submit"
        >
          Add 2FA key
        </button>
        <button className="kt-btn min-h-[44px]" onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Sites ─────────────────────────────────────────────────────────────────────────────────────────────

function SitesTab({ account, accounts, signIns, ops, busy, error, onOpenSite }: AccountDetailProps): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-panel="sites">
      {signIns.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-accounts-sites-empty="">
          This account does not sign in anywhere yet.
        </p>
      ) : (
        <ul aria-label="Sign-ins" className="m-0 flex list-none flex-col gap-2 p-0">
          {signIns.map(signIn => (
            <li
              key={signIn.id}
              className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-surface p-2"
              data-accounts-signin={signIn.id}
            >
              <button
                aria-label={`Open ${placeTitle(signIn.place)}`}
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-fg"
                onClick={() => onOpenSite(signIn)}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-ui font-medium">{placeTitle(signIn.place)}</span>
                  <span className="block break-words text-meta text-muted">{signInMethodWords(signIn)}</span>
                </span>
                <ChevronRight aria-hidden="true" className="shrink-0 text-faint" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Refusal error={error} />
      <AddSiteForm account={account} accounts={accounts} busy={busy} ops={ops} />
    </div>
  );
}

function AddSiteForm({
  account,
  accounts,
  ops,
  busy,
}: {
  readonly account: AccountSummary;
  readonly accounts: readonly AccountSummary[];
  readonly ops: AccountOps;
  readonly busy: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SignInDraft>({ method: 'password', ssoName: '', via: '', domains: '' });
  const domains = parseDomains(draft.domains);
  const problem = signInProblem(draft);
  const ready = domains.length > 0 && problem === undefined;

  if (!open)
    return (
      <div>
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-site-add-open=""
          onClick={() => setOpen(true)}
          type="button"
        >
          <Plus aria-hidden="true" size={14} /> Add a site
        </button>
      </div>
    );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || busy) return;
    const method = methodOfDraft(draft);
    const took = await ops.addSignIn(account.id, {
      place: { kind: 'site', domains, match: [] },
      ...(draft.method === 'password' ? {} : { method }),
    });
    if (took) {
      setDraft({ method: 'password', ssoName: '', via: '', domains: '' });
      setOpen(false);
    }
  };

  return (
    <form
      aria-label="Add a site"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3"
      data-accounts-site-form=""
      onSubmit={event => void submit(event)}
    >
      <MethodFields
        disabled={busy}
        draft={draft}
        onChange={setDraft}
        providers={accounts.filter(other => other.id !== account.id)}
        withDomains
      />
      {problem === undefined ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-site-add=""
          data-variant="primary"
          disabled={busy || !ready}
          type="submit"
        >
          Add site
        </button>
        <button className="kt-btn min-h-[44px]" onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}
