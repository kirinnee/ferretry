/**
 * ONE SIGN-IN (an account at a place): Method, Recipe (with the ferret's proposals), What Ferretry saw, Defaults.
 *
 * A recipe is drawn as plain text, never Markdown: one a ferret wrote must not load an image or show a link unlike its
 * target. A proposal is the ferret's words and is labelled so; the owner's own words are never drawn from a ferret.
 * A default only ORDERS the buttons on a sign-in card; the tap is still the permission.
 */

import {
  type AccountSummary,
  accountDefaultScopeWords,
  LOGIN_RECIPE_MAX_LENGTH,
  type LoginMethodKind,
  observedWords,
  recipeDiff,
  type SignInSummary,
} from '@ferretry/protocol';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  accountTitle,
  DEFAULT_ONLY_ORDERS,
  type DefaultsRead,
  defaultKeysOf,
  placeTitle,
  scopedLinesFor,
  siteDefaultFor,
} from '../../lib/accounts-screen.ts';
import { methodOfDraft, type SignInDraft, signInProblem } from '../../lib/login-form.ts';
import { type AccountOps, INPUT, Refusal, Tabs } from './accounts-parts.tsx';
import { MethodFields } from './method-fields.tsx';

export type SiteTab = 'method' | 'recipe' | 'seen' | 'defaults';

const TABS = [
  { id: 'method', label: 'Method' },
  { id: 'recipe', label: 'Recipe' },
  { id: 'seen', label: 'What Ferretry saw' },
  { id: 'defaults', label: 'Defaults' },
] as const;

export interface SiteDetailProps {
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
  readonly accounts: readonly AccountSummary[];
  readonly defaults: DefaultsRead | undefined;
  readonly ops: AccountOps;
  readonly busy: boolean;
  readonly error: string | null;
  readonly tab: SiteTab;
  readonly onTab: (tab: SiteTab) => void;
  readonly onClosed: () => void;
}

const DIFF_TONE = { ' ': 'text-muted', '-': 'bg-err-bg text-err', '+': 'bg-ok-bg text-ok' } as const;

export function SiteDetail(props: SiteDetailProps): ReactNode {
  const { signIn, account, tab, onTab } = props;
  return (
    <section
      aria-label={`${account.label} on ${placeTitle(signIn.place)}`}
      className="flex min-w-0 flex-col gap-3"
      data-accounts-site={signIn.id}
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 min-w-0 break-words text-row font-semibold text-fg">{placeTitle(signIn.place)}</h3>
        <p className="m-0 break-words text-meta text-muted">{accountTitle(account)}</p>
      </header>
      <Tabs label="Sign-in sections" onSelect={onTab} selected={tab} tabs={TABS} />
      {tab === 'method' ? <MethodTab {...props} /> : null}
      {tab === 'recipe' ? <RecipeTab {...props} /> : null}
      {tab === 'seen' ? <SeenTab {...props} /> : null}
      {tab === 'defaults' ? <DefaultsTab {...props} /> : null}
    </section>
  );
}

// ── Method ───────────────────────────────────────────────────────────────────────────────────────────

function MethodTab({ signIn, account, accounts, ops, busy, error, onClosed }: SiteDetailProps): ReactNode {
  const [draft, setDraft] = useState<SignInDraft>({
    method: signIn.method.kind as LoginMethodKind,
    ssoName: signIn.method.name ?? '',
    via: signIn.via?.account.id ?? '',
    domains: '',
  });
  const [confirming, setConfirming] = useState(false);
  const problem = signInProblem(draft);
  const method = methodOfDraft(draft);
  const changed =
    method.kind !== signIn.method.kind ||
    (method.name ?? '') !== (signIn.method.name ?? '') ||
    (method.via ?? '') !== (signIn.method.via ?? '');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!changed || problem !== undefined || busy) return;
    await ops.putSignIn(signIn.id, { method });
  };

  return (
    <form className="flex min-w-0 flex-col gap-3" data-accounts-panel="method" onSubmit={event => void submit(event)}>
      <p className="m-0 break-words text-cell text-muted">
        Where it signs in:{' '}
        {signIn.place.kind === 'site'
          ? signIn.place.domains.join(', ') || 'no login page named'
          : placeTitle(signIn.place)}
        {signIn.place.kind === 'site' && signIn.place.match.length > 0 ? ` · for ${signIn.place.match.join(', ')}` : ''}
      </p>
      <MethodFields
        disabled={busy}
        draft={draft}
        onChange={setDraft}
        providers={accounts.filter(other => other.id !== account.id)}
        withDomains={false}
      />
      {problem === undefined ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          {problem}
        </p>
      )}
      <Refusal error={error} />
      <div className="flex flex-wrap gap-2">
        <button
          className="kt-btn min-h-[44px]"
          data-accounts-method-save=""
          data-variant="primary"
          disabled={busy || !changed || problem !== undefined}
          type="submit"
        >
          Save method
        </button>
        {confirming ? (
          <>
            <button
              className="kt-btn min-h-[44px]"
              data-accounts-site-confirm-remove=""
              data-variant="danger"
              disabled={busy}
              onClick={() => void ops.removeSignIn(signIn.id).then(took => took && onClosed())}
              type="button"
            >
              Stop signing in here
            </button>
            <button className="kt-btn min-h-[44px]" onClick={() => setConfirming(false)} type="button">
              Keep it
            </button>
          </>
        ) : (
          <button
            aria-label={`Remove ${placeTitle(signIn.place)} from ${account.label}`}
            className="kt-btn min-h-[44px]"
            data-accounts-site-remove=""
            data-variant="danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} /> Remove this site
          </button>
        )}
      </div>
    </form>
  );
}

// ── Recipe ───────────────────────────────────────────────────────────────────────────────────────────

function RecipeTab({ signIn, ops, busy, error }: SiteDetailProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(signIn.recipe ?? '');
  const proposals = signIn.proposals ?? [];

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (text.trim() === '' || busy) return;
    if (await ops.putSignIn(signIn.id, { recipe: text })) setEditing(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-panel="recipe">
      {editing ? (
        <form className="flex min-w-0 flex-col gap-2" onSubmit={event => void save(event)}>
          <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
            Recipe
            <textarea
              className={`${INPUT} mono min-h-[140px] resize-y p-2 text-cell`}
              data-accounts-recipe-text=""
              maxLength={LOGIN_RECIPE_MAX_LENGTH}
              onChange={event => setText(event.target.value)}
              spellCheck={false}
              value={text}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="kt-btn min-h-[44px]"
              data-accounts-recipe-save=""
              data-variant="primary"
              disabled={busy || text.trim() === ''}
              type="submit"
            >
              <Check aria-hidden="true" size={14} /> Save recipe
            </button>
            <button className="kt-btn min-h-[44px]" onClick={() => setEditing(false)} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {signIn.recipe === undefined ? (
            <p className="m-0 text-cell text-faint" data-accounts-recipe-empty="">
              No recipe yet.
            </p>
          ) : (
            <>
              {signIn.recipeBy === 'ferret' ? (
                <p className="m-0 text-cell text-warn" data-accounts-recipe-unreviewed="">
                  Written by a ferret, not reviewed. Edit or save it to make it yours.
                </p>
              ) : null}
              <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell" data-accounts-recipe-body="">
                {signIn.recipe}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className="kt-btn min-h-[44px]"
              data-accounts-recipe-edit=""
              disabled={busy}
              onClick={() => {
                setText(signIn.recipe ?? '');
                setEditing(true);
              }}
              type="button"
            >
              {signIn.recipe === undefined ? (
                <Plus aria-hidden="true" size={14} />
              ) : (
                <Pencil aria-hidden="true" size={14} />
              )}{' '}
              {signIn.recipe === undefined ? 'Add recipe' : 'Edit recipe'}
            </button>
            {signIn.recipe === undefined ? null : (
              <button
                className="kt-btn min-h-[44px]"
                data-accounts-recipe-remove=""
                data-variant="danger"
                disabled={busy}
                onClick={() => void ops.putSignIn(signIn.id, { recipe: null })}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} /> Remove recipe
              </button>
            )}
          </div>
        </>
      )}

      {proposals.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-accounts-proposals="">
          <h4 className="m-0 text-cell font-semibold text-fg">Proposed changes</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {proposals.map(proposal => (
              <li
                key={proposal.id}
                className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface p-2"
                data-accounts-proposal={proposal.id}
              >
                <p className="m-0 min-w-0 break-words text-cell text-fg" data-accounts-proposal-why="">
                  The ferret says: {proposal.why}
                </p>
                <p className="m-0 text-meta text-faint">{proposal.proposedAt.slice(0, 10)}</p>
                <pre
                  className="mono m-0 min-w-0 whitespace-pre-wrap break-words rounded-control border border-border p-0 text-meta"
                  data-accounts-diff=""
                >
                  {recipeDiff(proposal.base, proposal.recipe).map((line, index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its place
                      key={index}
                      className={`block px-2 ${DIFF_TONE[line.op]}`}
                      data-diff-op={line.op}
                    >
                      {line.op === ' ' ? '  ' : `${line.op} `}
                      {line.text}
                    </span>
                  ))}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="kt-btn min-h-[44px]"
                    data-accounts-proposal-approve=""
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => void ops.decide(signIn.id, proposal.id, 'approve')}
                    type="button"
                  >
                    <Check aria-hidden="true" size={14} /> Approve
                  </button>
                  <button
                    className="kt-btn min-h-[44px]"
                    data-accounts-proposal-decline=""
                    disabled={busy}
                    onClick={() => void ops.decide(signIn.id, proposal.id, 'decline')}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} /> Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
        <input
          checked={signIn.autoApplyRecipe === true}
          className="h-5 w-5"
          data-accounts-auto-apply=""
          disabled={busy}
          onChange={event => void ops.putSignIn(signIn.id, { autoApplyRecipe: event.target.checked })}
          type="checkbox"
        />
        <span>Apply ferret recipe changes without asking</span>
      </label>
      <Refusal error={error} />
    </div>
  );
}

// ── What Ferretry saw ────────────────────────────────────────────────────────────────────────────────

function SeenTab({ signIn }: SiteDetailProps): ReactNode {
  const observed = signIn.observed ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-2" data-accounts-panel="seen">
      {observed.length === 0 ? (
        <p className="m-0 text-cell text-faint" data-accounts-seen-empty="">
          Ferretry has not seen this sign-in happen yet.
        </p>
      ) : (
        <ul aria-label="What Ferretry saw" className="m-0 flex list-none flex-col gap-1 p-0">
          {observed.map(seen => (
            <li key={`${seen.surface}:${seen.at}`} className="min-w-0 break-words text-cell text-muted">
              {observedWords(seen)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Defaults ─────────────────────────────────────────────────────────────────────────────────────────

function DefaultsTab({ signIn, account, accounts, defaults, ops, busy, error }: SiteDetailProps): ReactNode {
  const keys = defaultKeysOf(signIn.place);
  const file = defaults?.kind === 'read' ? defaults.file : undefined;
  const scoped = file === undefined ? [] : scopedLinesFor(file, account.id, keys);
  const label = (id: string): string => accounts.find(each => each.id === id)?.label ?? id;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-accounts-panel="defaults">
      <p className="m-0 text-cell text-muted" data-accounts-defaults-note="">
        {DEFAULT_ONLY_ORDERS}
      </p>
      {defaults === undefined ? (
        <p className="m-0 text-cell text-faint" role="status">
          Reading the defaults…
        </p>
      ) : defaults.kind === 'unreadable' ? (
        <p className="m-0 text-cell text-warn" data-accounts-defaults-unreadable="" role="alert">
          {defaults.why}. Fix it in Settings › Config files; it is not the same as having no defaults.
        </p>
      ) : (
        <ul aria-label="Defaults" className="m-0 flex list-none flex-col gap-2 p-0">
          {keys.map(key => {
            const current = siteDefaultFor(defaults.file, key);
            const mine = current === account.id;
            return (
              <li
                key={key}
                className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface p-2"
                data-accounts-default-key={key}
              >
                <p className="m-0 break-words text-ui font-medium text-fg">{key}</p>
                <p className="m-0 break-words text-meta text-muted" data-accounts-default-current="">
                  {current === undefined
                    ? 'No default: the card lists accounts in its own order.'
                    : mine
                      ? `${account.label} is listed first.`
                      : `${label(current)} is listed first.`}
                </p>
                <div>
                  {mine ? (
                    <button
                      aria-label={`Stop ${account.label} being the default on ${key}`}
                      className="kt-btn min-h-[44px]"
                      data-accounts-default-clear=""
                      disabled={busy}
                      onClick={() => void ops.setDefault({ scope: 'sites', key, account: null })}
                      type="button"
                    >
                      Stop listing it first
                    </button>
                  ) : (
                    <button
                      aria-label={`Make ${account.label} the default on ${key}`}
                      className="kt-btn min-h-[44px]"
                      data-accounts-default-set=""
                      data-variant="primary"
                      disabled={busy}
                      onClick={() => void ops.setDefault({ scope: 'sites', key, account: account.id })}
                      type="button"
                    >
                      List {account.label} first
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {scoped.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-accounts-default-scoped="">
          <h4 className="m-0 text-cell font-semibold text-fg">Set for one project or folder</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {scoped.map(line => (
              <li
                key={`${line.scope}:${line.within ?? ''}:${line.key}`}
                className="flex min-w-0 items-center justify-between gap-2 text-cell text-muted"
              >
                <span className="min-w-0 break-words">
                  {line.key} · {accountDefaultScopeWords(line)}
                </span>
                <button
                  aria-label={`Remove the ${line.key} default for ${accountDefaultScopeWords(line)}`}
                  className="kt-btn min-h-[44px]"
                  disabled={busy}
                  onClick={() =>
                    void ops.setDefault({
                      scope: line.scope,
                      ...(line.within === undefined ? {} : { within: line.within }),
                      key: line.key,
                      account: null,
                    })
                  }
                  type="button"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Refusal error={error} />
    </div>
  );
}
