/**
 * SETTINGS › ACCOUNTS: the sign-ins and 2FA keys a machine holds, grouped by the site they sign in at.
 *
 * The screen is a pure drawing of a list the daemon sent: it shows which fields EXIST, never a value, and every change
 * goes out through `ops`, which the live surface wires to person routes only. A damaged store is said to be damaged,
 * never drawn as an empty list.
 */

import {
  type AccountId,
  AccountIdSchema,
  type AccountList,
  type AccountSummary,
  type SignInSummary,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { ArrowLeft, ChevronRight, Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  accountsBySite,
  accountTitle,
  type DefaultsRead,
  factorsWords,
  fieldsWords,
  lookAlikeGroups,
  pairsOf,
  signInMethodWords,
} from '../../lib/accounts-screen.ts';
import type { InputClient } from '../../lib/input-api.ts';
import { handleFromLabel, parseDomains, passwordProblem } from '../../lib/login-form.ts';
import { AccountDetail, type AccountTab } from './account-detail.tsx';
import { type AccountOps, INPUT, Refusal } from './accounts-parts.tsx';
import { SiteDetail, type SiteTab } from './site-detail.tsx';

type AccountsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'account'; readonly id: AccountId; readonly tab: AccountTab }
  | { readonly kind: 'site'; readonly id: SignInSummary['id']; readonly tab: SiteTab };

export interface AccountsScreenProps {
  readonly list: AccountList;
  /** Handles the daemon thinks are one account; empty when it has no such route. */
  readonly lookAlike: readonly (readonly AccountId[])[];
  readonly defaults: DefaultsRead;
  readonly ops: AccountOps;
  readonly busy: boolean;
  readonly error: string | null;
  readonly client: InputClient;
  readonly addKey: ((stage: TwoFactorStageId, words: string) => Promise<boolean>) | undefined;
  /** Whether this machine has 2FA keys at all; without it the 2FA keys tab is not offered. */
  readonly withKeys: boolean;
  /** A seed was just saved by the shared panel: read the list again. */
  readonly onRefresh: () => void;
  /** Called when the person moves between views, so a refusal from the last one stops showing. */
  readonly onNavigate?: () => void;
  readonly initialView?: AccountsView;
}

export function AccountsScreen(props: AccountsScreenProps): ReactNode {
  const { list, ops, busy, error, onNavigate } = props;
  const [view, setView] = useState<AccountsView>(props.initialView ?? { kind: 'list' });
  const go = (next: AccountsView): void => {
    onNavigate?.();
    setView(next);
  };
  const back = (): void => go({ kind: 'list' });

  const account = view.kind === 'account' ? list.accounts.find(each => each.id === view.id) : undefined;
  const signIn = view.kind === 'site' ? list.signIns.find(each => each.id === view.id) : undefined;
  const siteAccount = signIn === undefined ? undefined : list.accounts.find(each => each.id === signIn.account);

  if (view.kind === 'account' && account !== undefined) {
    return (
      <Frame back={back} backLabel="All accounts">
        <AccountDetail
          account={account}
          accounts={list.accounts}
          addKey={props.addKey}
          withKeys={props.withKeys}
          busy={busy}
          client={props.client}
          error={error}
          onClosed={back}
          onOpenSite={each => go({ kind: 'site', id: each.id, tab: 'method' })}
          onSaved={props.onRefresh}
          onTab={tab => go({ kind: 'account', id: account.id, tab })}
          ops={ops}
          signIns={list.signIns.filter(each => each.account === account.id)}
          tab={view.tab}
        />
      </Frame>
    );
  }
  if (view.kind === 'site' && signIn !== undefined && siteAccount !== undefined) {
    return (
      <Frame
        back={() => go({ kind: 'account', id: siteAccount.id, tab: 'sites' })}
        backLabel={accountTitle(siteAccount)}
      >
        <SiteDetail
          account={siteAccount}
          accounts={list.accounts}
          busy={busy}
          defaults={props.defaults}
          error={error}
          onClosed={() => go({ kind: 'account', id: siteAccount.id, tab: 'sites' })}
          onTab={tab => go({ kind: 'site', id: signIn.id, tab })}
          ops={ops}
          signIn={signIn}
          tab={view.tab}
        />
      </Frame>
    );
  }
  return <ListView {...props} onOpen={go} />;
}

function Frame({
  back,
  backLabel,
  children,
}: {
  readonly back: () => void;
  readonly backLabel: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-screen="">
      <div>
        <button className="kt-btn min-h-[44px]" data-accounts-back="" onClick={back} type="button">
          <ArrowLeft aria-hidden="true" size={14} /> {backLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────

function ListView({
  list,
  lookAlike,
  ops,
  busy,
  error,
  onOpen,
}: AccountsScreenProps & { readonly onOpen: (view: AccountsView) => void }): ReactNode {
  const { groups, unplaced } = accountsBySite(list);
  const similar = lookAlikeGroups(lookAlike, list);
  const damaged = list.health === 'damaged';

  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-screen="">
      {damaged ? (
        <p className="m-0 text-ui text-err" data-accounts-damaged="" role="alert">
          {list.diagnosis ?? 'The account store could not be read cleanly.'} What is listed here may not be everything
          saved.
        </p>
      ) : null}
      {similar.map(group => (
        <LookAlikeBanner key={group.map(each => each.id).join('|')} accounts={group} busy={busy} ops={ops} />
      ))}
      {list.accounts.length === 0 && !damaged ? (
        <p className="m-0 text-ui text-faint" data-accounts-empty="">
          No accounts saved on this machine yet.
        </p>
      ) : null}
      {groups.map(group => (
        <section
          key={group.key}
          aria-label={group.key}
          className="flex min-w-0 flex-col gap-1"
          data-accounts-site-group={group.key}
        >
          <h3 className="m-0 break-words text-cell font-semibold text-muted">{group.key}</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {group.rows.map(({ signIn, account }) => (
              <li
                key={signIn.id}
                className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-surface px-2"
                data-accounts-row={account.id}
              >
                <button
                  aria-label={`Open ${accountTitle(account)}`}
                  className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-fg"
                  onClick={() => onOpen({ kind: 'account', id: account.id, tab: 'details' })}
                  type="button"
                >
                  <AccountLine account={account} method={signInMethodWords(signIn)} />
                  <ChevronRight aria-hidden="true" className="shrink-0 text-faint" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {unplaced.length === 0 ? null : (
        <section
          aria-label="Not signed in anywhere yet"
          className="flex min-w-0 flex-col gap-1"
          data-accounts-unplaced=""
        >
          <h3 className="m-0 text-cell font-semibold text-muted">No site yet</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {unplaced.map(account => (
              <li
                key={account.id}
                className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-surface px-2"
                data-accounts-row={account.id}
              >
                <button
                  aria-label={`Open ${accountTitle(account)}`}
                  className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-fg"
                  onClick={() => onOpen({ kind: 'account', id: account.id, tab: 'details' })}
                  type="button"
                >
                  <AccountLine account={account} method={undefined} />
                  <ChevronRight aria-hidden="true" className="shrink-0 text-faint" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Refusal error={error} />
      <AddAccountForm accounts={list.accounts} busy={busy} ops={ops} onOpen={onOpen} />
    </div>
  );
}

function AccountLine({
  account,
  method,
}: {
  readonly account: AccountSummary;
  readonly method: string | undefined;
}): ReactNode {
  return (
    <span className="min-w-0 flex-1 py-1">
      <span className="block break-words text-ui font-medium">{accountTitle(account)}</span>
      <span className="block break-words text-meta text-muted">
        {[method, fieldsWords(account), factorsWords(account)]
          .filter(part => part !== undefined && part !== '')
          .join(' · ')}
      </span>
    </span>
  );
}

// ── Look-alikes ──────────────────────────────────────────────────────────────────────────────────────

function LookAlikeBanner({
  accounts,
  ops,
  busy,
}: {
  readonly accounts: readonly AccountSummary[];
  readonly ops: AccountOps;
  readonly busy: boolean;
}): ReactNode {
  const [merging, setMerging] = useState(false);
  const [keep, setKeep] = useState<AccountId>(accounts[0]?.id ?? '');
  const names = accounts.map(each => each.label).join(', ');

  const merge = async (): Promise<void> => {
    for (const other of accounts.filter(each => each.id !== keep)) {
      if (!(await ops.merge(keep, other.id))) return;
    }
  };
  const apart = async (): Promise<void> => {
    for (const [one, other] of pairsOf(accounts)) {
      if (!(await ops.apart(one.id, other.id))) return;
    }
  };

  return (
    <section
      aria-label="These may be one account"
      className="flex min-w-0 flex-col gap-2 rounded-control border border-warn bg-warn-bg p-3"
      data-accounts-lookalike=""
    >
      <p className="m-0 min-w-0 break-words text-ui text-fg">
        <strong>These may be one account:</strong> {names}. They share a username and a password.
      </p>
      {merging ? (
        <div className="flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
            Keep which one
            <select
              className={INPUT}
              data-accounts-merge-keep=""
              disabled={busy}
              onChange={event => setKeep(event.target.value)}
              value={keep}
            >
              {accounts.map(each => (
                <option key={each.id} value={each.id}>
                  {accountTitle(each)}
                </option>
              ))}
            </select>
          </label>
          <p className="m-0 text-meta text-muted">The others' sites and 2FA keys move onto it, and they are removed.</p>
          <div className="flex flex-wrap gap-2">
            <button
              className="kt-btn min-h-[44px]"
              data-accounts-merge-confirm=""
              data-variant="primary"
              disabled={busy}
              onClick={() => void merge()}
              type="button"
            >
              Merge into one
            </button>
            <button className="kt-btn min-h-[44px]" onClick={() => setMerging(false)} type="button">
              Not now
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            className="kt-btn min-h-[44px]"
            data-accounts-merge=""
            data-variant="primary"
            disabled={busy}
            onClick={() => setMerging(true)}
            type="button"
          >
            Merge
          </button>
          <button
            className="kt-btn min-h-[44px]"
            data-accounts-apart=""
            disabled={busy}
            onClick={() => void apart()}
            type="button"
          >
            Keep apart
          </button>
        </div>
      )}
    </section>
  );
}

// ── Add ──────────────────────────────────────────────────────────────────────────────────────────────

function AddAccountForm({
  accounts,
  ops,
  busy,
  onOpen,
}: {
  readonly accounts: readonly AccountSummary[];
  readonly ops: AccountOps;
  readonly busy: boolean;
  readonly onOpen: (view: AccountsView) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [handle, setHandle] = useState('');
  const [handleEdited, setHandleEdited] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [site, setSite] = useState('');

  const id = AccountIdSchema.safeParse(handle.trim());
  const taken = id.success && accounts.some(each => each.id === id.data);
  const domains = parseDomains(site);
  const siteProblem =
    site.trim() !== '' && domains.length === 0 ? 'That is not a web host, like app.vercel.com.' : undefined;
  const problem = passwordProblem(password) ?? siteProblem;
  const ready = label.trim() !== '' && id.success && !taken && password !== '' && problem === undefined;

  if (!open)
    return (
      <div>
        <button className="kt-btn min-h-[44px]" data-accounts-add-open="" onClick={() => setOpen(true)} type="button">
          <Plus aria-hidden="true" size={14} /> Add an account
        </button>
      </div>
    );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || !id.success || busy) return;
    const made = await ops.putAccount(id.data, {
      label: label.trim(),
      ...(username.trim() === '' ? {} : { username: username.trim() }),
      password,
    });
    setPassword('');
    if (!made) return;
    if (domains.length > 0) await ops.addSignIn(id.data, { place: { kind: 'site', domains: [...domains], match: [] } });
    setOpen(false);
    onOpen({ kind: 'account', id: id.data, tab: 'details' });
  };

  return (
    <form
      aria-label="Add an account"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3"
      data-accounts-add=""
      onSubmit={event => void submit(event)}
    >
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Name
        <input
          autoComplete="off"
          className={INPUT}
          data-accounts-new-label=""
          disabled={busy}
          onChange={event => {
            setLabel(event.target.value);
            if (!handleEdited) setHandle(handleFromLabel(event.target.value));
          }}
          placeholder="GitHub (kirinnee)"
          value={label}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Handle
        <input
          autoCapitalize="characters"
          autoComplete="off"
          className={`${INPUT} mono`}
          data-accounts-new-handle=""
          disabled={busy}
          onChange={event => {
            setHandleEdited(true);
            setHandle(event.target.value.toUpperCase());
          }}
          spellCheck={false}
          value={handle}
        />
      </label>
      {handle !== '' && !id.success ? (
        <p className="m-0 text-meta text-err" role="alert">
          A handle is capital letters, digits and underscores, starting with a letter.
        </p>
      ) : null}
      {taken ? (
        <p className="m-0 text-meta text-err" role="alert">
          An account with that handle is already saved.
        </p>
      ) : null}
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Username
        <input
          autoCapitalize="off"
          autoComplete="off"
          className={INPUT}
          data-accounts-new-username=""
          disabled={busy}
          onChange={event => setUsername(event.target.value)}
          spellCheck={false}
          value={username}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Password
        <input
          autoComplete="new-password"
          className={INPUT}
          data-accounts-new-password=""
          disabled={busy}
          onChange={event => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        Signs in at (optional)
        <input
          autoCapitalize="off"
          autoComplete="off"
          className={INPUT}
          data-accounts-new-site=""
          disabled={busy}
          onChange={event => setSite(event.target.value)}
          placeholder="github.com"
          spellCheck={false}
          value={site}
        />
      </label>
      {problem === undefined ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-new-save=""
          data-variant="primary"
          disabled={busy || !ready}
          type="submit"
        >
          Save account
        </button>
        <button className="kt-btn min-h-[44px]" onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}
