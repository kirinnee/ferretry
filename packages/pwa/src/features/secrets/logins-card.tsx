/**
 * Settings › Accounts: the password manager the input card places values from.
 *
 * WRITE-ONLY, like the secrets above it. A person can add an entry, change what it is for, replace its
 * password, add or remove a 2FA seed, rename its handle and delete it. Nothing here can show a value: the
 * list says WHICH secret fields an entry holds (password ✓, 2FA ✓), never what they are, and a password or
 * seed field is a fresh empty box every time.
 *
 * A DAMAGED STORE IS NOT AN EMPTY ONE. It gets its own message, because a person told "no accounts" over
 * a store the daemon simply could not read will type them all again.
 */

import {
  LOGIN_PASSWORD_MIN_LENGTH,
  LOGIN_SSO_NAME_MAX_LENGTH,
  LOGIN_TOTP_WARNING,
  type LoginEntryList,
  type LoginEntrySummary,
  type PutLoginEntryRequest,
} from '@ferretry/protocol';
import { AlertTriangle, Check, LockKeyhole, Pencil, Plus, ShieldPlus, Trash2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { normalizeHandle } from '../../lib/input-card.ts';
import {
  addTotpBody,
  canAddLogin,
  domainsWords,
  editLoginBody,
  fieldWords,
  handleFromLabel,
  METHOD_OPTIONS,
  matchText,
  methodWords,
  newLoginBody,
  newLoginProblem,
  passwordProblem,
  removeTotpBody,
  replacePasswordBody,
  type SignInDraft,
  seedProblem,
  signInDraftOf,
  signInProblem,
  viaChoices,
} from '../../lib/login-form.ts';
import { LoginRecipe } from './login-recipe.tsx';

/** A write reports whether it took, so a form clears only when the daemon accepted it. */
type Write = Promise<boolean> | boolean;

export interface LoginsCardProps {
  readonly list: LoginEntryList;
  readonly busy?: string | null;
  readonly error?: string | null;
  readonly onPut: (id: string, body: PutLoginEntryRequest) => Write;
  readonly onRename: (id: string, to: string) => Write;
  readonly onRemove: (id: string) => Write;
  readonly onDecide: (id: string, proposalId: string, decision: 'approve' | 'decline') => Write;
}

const INPUT = 'kt-input min-h-[44px] w-full rounded-control border border-border bg-surface-2 px-2 text-fg';

function Field({ label, children }: { readonly label: string; readonly children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-cell font-medium text-fg">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/** The sign-in method, the provider login it goes via, and the login domains: the same three fields on add and edit. */
function SignInFields({
  draft,
  choices,
  kind,
  onChange,
}: {
  readonly draft: SignInDraft;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly kind: 'new' | 'edit';
  readonly onChange: (next: SignInDraft) => void;
}) {
  const data = (name: string) => ({ [`data-login-${kind}-${name}`]: '' });
  return (
    <>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="Sign-in method">
          {fieldId => (
            <select
              id={fieldId}
              className={INPUT}
              value={draft.method}
              {...data('method')}
              onChange={event => {
                const method = event.target.value as SignInDraft['method'];
                onChange({ ...draft, method, via: method === 'password' ? '' : draft.via });
              }}
            >
              {METHOD_OPTIONS.map(option => (
                <option key={option.kind} value={option.kind}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {draft.method === 'sso' && (
          <Field label="SSO provider">
            {fieldId => (
              <input
                id={fieldId}
                className={INPUT}
                value={draft.ssoName}
                placeholder="Okta"
                maxLength={LOGIN_SSO_NAME_MAX_LENGTH}
                autoComplete="off"
                {...data('sso-name')}
                onChange={event => onChange({ ...draft, ssoName: event.target.value })}
              />
            )}
          </Field>
        )}
      </div>
      {draft.method !== 'password' && (
        <Field label="Via (provider's login)">
          {fieldId => (
            <select
              id={fieldId}
              className={INPUT}
              value={draft.via}
              {...data('via')}
              onChange={event => onChange({ ...draft, via: event.target.value })}
            >
              <option value="">None</option>
              {choices.map(choice => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <Field label="Login domain(s)">
        {fieldId => (
          <input
            id={fieldId}
            className={`${INPUT} mono`}
            value={draft.domains}
            placeholder="app.vercel.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            {...data('domains')}
            onChange={event => onChange({ ...draft, domains: event.target.value })}
          />
        )}
      </Field>
    </>
  );
}

function Problem({ children }: { readonly children: string | undefined }) {
  if (children === undefined) return null;
  return (
    <p role="alert" className="m-0 text-meta text-err" data-login-problem="">
      {children}
    </p>
  );
}

function AddLoginForm({
  entries,
  busy,
  onPut,
  onClose,
}: {
  readonly entries: readonly LoginEntrySummary[];
  readonly busy: boolean;
  readonly onPut: LoginsCardProps['onPut'];
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [match, setMatch] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [signIn, setSignIn] = useState<SignInDraft>(() => signInDraftOf(undefined, entries));
  const held = entries.map(entry => entry.id);
  const draft = { label, id, match, username, password, ...signIn };
  const problem = newLoginProblem(draft, held);
  const ready = canAddLogin(draft, held) && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onPut(id, newLoginBody(draft))).then(ok => {
      setPassword('');
      if (ok) onClose();
    });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border-strong bg-surface-2 p-3"
      aria-label="Add an account"
      data-login-add=""
      onSubmit={submit}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="Label">
          {fieldId => (
            <input
              id={fieldId}
              className={INPUT}
              value={label}
              placeholder="GitHub (kirinnee)"
              autoComplete="off"
              data-login-new-label=""
              onChange={event => {
                setLabel(event.target.value);
                if (!idEdited) setId(handleFromLabel(event.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Handle">
          {fieldId => (
            <input
              id={fieldId}
              className={`${INPUT} mono`}
              value={id}
              placeholder="GITHUB_KIRINNEE"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              data-login-new-id=""
              onChange={event => {
                setIdEdited(true);
                setId(normalizeHandle(event.target.value));
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Used for">
        {fieldId => (
          <input
            id={fieldId}
            className={`${INPUT} mono`}
            value={match}
            placeholder="sudo@kirin-box, github.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-login-new-match=""
            onChange={event => setMatch(event.target.value)}
          />
        )}
      </Field>
      <SignInFields draft={signIn} choices={viaChoices(entries, undefined)} kind="new" onChange={setSignIn} />
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="Username (optional)">
          {fieldId => (
            <input
              id={fieldId}
              className={INPUT}
              value={username}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-login-new-username=""
              onChange={event => setUsername(event.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {fieldId => (
            <input
              id={fieldId}
              type="password"
              className={INPUT}
              value={password}
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-login-new-password=""
              onChange={event => setPassword(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Problem>{problem}</Problem>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="kt-btn min-h-[44px]" data-variant="primary" disabled={!ready}>
          <Plus size={14} aria-hidden="true" /> {busy ? 'Saving…' : 'Add login'}
        </button>
        <button type="button" className="kt-btn min-h-[44px]" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type RowMode = 'view' | 'edit' | 'password' | 'rename' | 'totp' | 'delete';

function LoginRow({
  entry,
  entries,
  busy,
  onPut,
  onRename,
  onRemove,
  onDecide,
  error,
  onRefused,
}: {
  readonly entry: LoginEntrySummary;
  readonly entries: readonly LoginEntrySummary[];
  readonly busy: boolean;
  readonly onPut: LoginsCardProps['onPut'];
  readonly onRename: LoginsCardProps['onRename'];
  readonly onRemove: LoginsCardProps['onRemove'];
  readonly onDecide: LoginsCardProps['onDecide'];
  readonly error: string | null;
  readonly onRefused: (id: string) => void;
}) {
  const [mode, setMode] = useState<RowMode>('view');
  const [label, setLabel] = useState(entry.label);
  const [match, setMatch] = useState(matchText(entry.match));
  const [username, setUsername] = useState(entry.username ?? '');
  const [password, setPassword] = useState('');
  const [seed, setSeed] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [handle, setHandle] = useState(entry.id);
  const [signIn, setSignIn] = useState<SignInDraft>(() => signInDraftOf(entry, entries));
  const held = entries.map(each => each.id);

  const close = () => {
    setMode('view');
    setPassword('');
    setSeed('');
    setAcknowledged(false);
  };
  /** Runs a write and returns to the row only if the daemon took it; a password or seed box never survives. */
  const run = (write: Write) =>
    void Promise.resolve(write).then(ok => {
      setPassword('');
      setSeed('');
      if (ok) close();
    });

  const edit = editLoginBody(entry, { label, match, username, ...signIn });
  const signInWrong = signInProblem(signIn);
  const seedWrong = seedProblem(seed);
  const totp = addTotpBody(seed, acknowledged);
  const passwordWrong = passwordProblem(password);
  const renameTarget = handle.trim();
  const renameWrong =
    renameTarget === entry.id || renameTarget === ''
      ? undefined
      : held.includes(renameTarget)
        ? `${renameTarget} already exists.`
        : undefined;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border-strong bg-surface-2 px-3 py-2"
      data-login={entry.id}
      data-login-mode={mode}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-ui font-semibold text-fg" data-login-label="">
          {entry.label}
        </span>
        <span className="mono text-meta text-faint">{entry.id}</span>
        <span className="text-meta text-muted" data-login-fields="">
          {fieldWords(entry).join(' · ')}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
        <span data-login-match="">
          {entry.match.length === 0 ? 'matches nothing yet' : `for ${matchText(entry.match)}`}
        </span>
        {entry.username !== undefined && <span data-login-username="">user {entry.username}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
        <span className="min-w-0 break-words" data-login-method="">
          {methodWords(entry, entries)}
        </span>
        {domainsWords(entry) !== undefined && (
          <span className="min-w-0 break-words" data-login-domains="">
            {domainsWords(entry)}
          </span>
        )}
      </div>

      {mode === 'view' && (
        <div className="flex flex-wrap gap-2" data-login-actions="">
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={busy}
            onClick={() => setMode('edit')}
            aria-label={`Edit ${entry.label}`}
          >
            <Pencil size={14} aria-hidden="true" /> Edit
          </button>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={busy}
            onClick={() => setMode('password')}
            aria-label={`Replace password for ${entry.label}`}
          >
            <LockKeyhole size={14} aria-hidden="true" /> Replace password
          </button>
          {entry.fields.totp ? (
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={busy}
              onClick={() => run(onPut(entry.id, removeTotpBody()))}
              aria-label={`Remove 2FA from ${entry.label}`}
            >
              <X size={14} aria-hidden="true" /> Remove 2FA
            </button>
          ) : (
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={busy}
              onClick={() => setMode('totp')}
              aria-label={`Add 2FA seed to ${entry.label}`}
            >
              <ShieldPlus size={14} aria-hidden="true" /> Add 2FA seed
            </button>
          )}
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={busy}
            onClick={() => setMode('rename')}
            aria-label={`Rename handle of ${entry.label}`}
          >
            Rename handle
          </button>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="danger"
            disabled={busy}
            onClick={() => setMode('delete')}
            aria-label={`Delete ${entry.label}`}
          >
            <Trash2 size={14} aria-hidden="true" /> Delete
          </button>
        </div>
      )}

      {mode === 'view' && (
        <LoginRecipe entry={entry} busy={busy} error={error} onPut={onPut} onDecide={onDecide} onRefused={onRefused} />
      )}

      {mode === 'edit' && (
        <form
          className="flex min-w-0 flex-col gap-2"
          aria-label={`Edit ${entry.label}`}
          onSubmit={event => {
            event.preventDefault();
            if (edit !== undefined && !busy) run(onPut(entry.id, edit));
          }}
        >
          <Field label="Label">
            {fieldId => (
              <input
                id={fieldId}
                className={INPUT}
                value={label}
                autoComplete="off"
                data-login-edit-label=""
                onChange={event => setLabel(event.target.value)}
              />
            )}
          </Field>
          <Field label="Used for">
            {fieldId => (
              <input
                id={fieldId}
                className={`${INPUT} mono`}
                value={match}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="sudo@kirin-box, github.com"
                data-login-edit-match=""
                onChange={event => setMatch(event.target.value)}
              />
            )}
          </Field>
          <SignInFields draft={signIn} choices={viaChoices(entries, entry.id)} kind="edit" onChange={setSignIn} />
          <Field label="Username">
            {fieldId => (
              <input
                id={fieldId}
                className={INPUT}
                value={username}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                data-login-edit-username=""
                onChange={event => setUsername(event.target.value)}
              />
            )}
          </Field>
          <Problem>{signInWrong}</Problem>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              disabled={edit === undefined || busy}
            >
              <Check size={14} aria-hidden="true" /> Save changes
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              onClick={() => {
                setSignIn(signInDraftOf(entry, entries));
                close();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'password' && (
        <form
          className="flex min-w-0 flex-col gap-2"
          aria-label={`Replace password for ${entry.label}`}
          onSubmit={event => {
            event.preventDefault();
            if (password.length >= LOGIN_PASSWORD_MIN_LENGTH && !busy)
              run(onPut(entry.id, replacePasswordBody(password)));
          }}
        >
          <Field label="New password">
            {fieldId => (
              <input
                id={fieldId}
                type="password"
                className={INPUT}
                value={password}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-login-replace-password=""
                onChange={event => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Problem>{passwordWrong}</Problem>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              disabled={password.length < LOGIN_PASSWORD_MIN_LENGTH || busy}
            >
              Replace password
            </button>
            <button type="button" className="kt-btn min-h-[44px]" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'totp' && (
        <form
          className="flex min-w-0 flex-col gap-2"
          aria-label={`Add 2FA seed to ${entry.label}`}
          data-login-totp=""
          onSubmit={event => {
            event.preventDefault();
            if (totp !== undefined && !busy) run(onPut(entry.id, totp));
          }}
        >
          <p
            className="m-0 flex gap-2 rounded-control border border-warn bg-warn/10 p-2 text-cell leading-base text-fg"
            data-login-totp-warning=""
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <span>{LOGIN_TOTP_WARNING}</span>
          </p>
          <label className="flex items-start gap-2 text-cell text-fg">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked={acknowledged}
              data-login-totp-ack=""
              onChange={event => setAcknowledged(event.target.checked)}
            />
            <span>I understand, keep the 2FA seed with this password.</span>
          </label>
          <Field label="2FA seed">
            {fieldId => (
              <input
                id={fieldId}
                type="password"
                className={`${INPUT} mono`}
                value={seed}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Base32 setup key"
                data-login-totp-seed=""
                onChange={event => setSeed(event.target.value)}
              />
            )}
          </Field>
          <Problem>{seedWrong}</Problem>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              disabled={totp === undefined || busy}
            >
              Add 2FA seed
            </button>
            <button type="button" className="kt-btn min-h-[44px]" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'rename' && (
        <form
          className="flex min-w-0 flex-col gap-2"
          aria-label={`Rename handle of ${entry.label}`}
          onSubmit={event => {
            event.preventDefault();
            if (renameTarget !== entry.id && renameWrong === undefined && renameTarget !== '' && !busy)
              run(onRename(entry.id, renameTarget));
          }}
        >
          <Field label="Handle">
            {fieldId => (
              <input
                id={fieldId}
                className={`${INPUT} mono`}
                value={handle}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                data-login-rename-handle=""
                onChange={event => setHandle(normalizeHandle(event.target.value))}
              />
            )}
          </Field>
          <Problem>{renameWrong}</Problem>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              disabled={renameTarget === entry.id || renameTarget === '' || renameWrong !== undefined || busy}
            >
              Rename
            </button>
            <button type="button" className="kt-btn min-h-[44px]" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'delete' && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-login-confirm="">
          <legend className="sr-only">{`Delete ${entry.label}?`}</legend>
          <p className="m-0 text-cell leading-base text-fg">
            Delete <strong>{entry.label}</strong>? Its password{entry.fields.totp ? ' and 2FA seed are' : ' is'} removed
            from this machine. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-variant="danger"
              disabled={busy}
              data-login-confirm-delete=""
              onClick={() => run(onRemove(entry.id))}
            >
              <Trash2 size={14} aria-hidden="true" /> Delete it
            </button>
            <button type="button" className="kt-btn min-h-[44px]" onClick={close}>
              Keep it
            </button>
          </div>
        </fieldset>
      )}
    </li>
  );
}

export function LoginsCard({ list, busy = null, error = null, onPut, onRename, onRemove, onDecide }: LoginsCardProps) {
  const [adding, setAdding] = useState(false);
  /** The row whose recipe action was refused: it shows the message beside its own controls, once. */
  const [claimed, setClaimed] = useState<string | null>(null);
  if (error === null && claimed !== null) setClaimed(null);
  const working = busy !== null;

  return (
    <section
      className="kt-panel flex flex-col gap-3 p-panel"
      aria-labelledby="logins-heading"
      data-testid="logins-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="logins-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <LockKeyhole size={16} className="text-accent" aria-hidden="true" />
          Accounts
        </h2>
        <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">write-only</span>
      </div>
      <p className="m-0 text-cell leading-base text-muted">Passwords are write-only; ferrets never see them.</p>

      {list.health === 'damaged' ? (
        <div
          role="alert"
          className="flex gap-2 rounded-control border border-warn bg-warn/10 p-3"
          data-testid="logins-damaged"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0">
            <p className="m-0 text-ui font-semibold text-fg">This daemon cannot read its accounts</p>
            {list.diagnosis !== undefined && (
              <p className="m-0 mt-1 text-cell leading-base text-muted">{list.diagnosis}</p>
            )}
            <p className="m-0 mt-1 text-meta leading-base text-warn">
              It is not empty. Do not add these again until it is readable, or you will write over entries that are
              still there.
            </p>
          </div>
        </div>
      ) : list.entries.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-testid="logins-empty">
          No accounts on this daemon yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Accounts">
          {list.entries.map(entry => (
            <LoginRow
              key={entry.id}
              entry={entry}
              entries={list.entries}
              busy={working}
              onPut={onPut}
              onRename={onRename}
              onRemove={onRemove}
              onDecide={onDecide}
              error={claimed === entry.id ? error : null}
              onRefused={setClaimed}
            />
          ))}
        </ul>
      )}

      {error !== null && claimed === null && (
        <p role="alert" className="m-0 text-ui text-err" data-testid="logins-error">
          {error}
        </p>
      )}

      {list.health !== 'damaged' &&
        (adding ? (
          <AddLoginForm entries={list.entries} busy={working} onPut={onPut} onClose={() => setAdding(false)} />
        ) : (
          <div>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-login-add-open=""
              onClick={() => setAdding(true)}
            >
              <Plus size={14} aria-hidden="true" /> Add an account
            </button>
          </div>
        ))}
    </section>
  );
}
