/**
 * The Sign-ins tab (docs/design/account-model.md §4.2): the logins kept on this machine, grouped by harness, each
 * with its status, its usage and who uses it — and each login's own page, where it is checked, signed in and (for an
 * environment login) tested.
 *
 * One page is one login. This screen reads and acts through Logins' own routes only (`GET /v1/logins`, check, test,
 * sign-in, local models, and the login change routes: add, label, switch off or on, sign out, remove). Every act that
 * changes the machine ends in a `ChangeApplyPanel`, so a caller that may not change it is told why before it clicks.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { LoginView } from '../../contract/index.ts';
import { AccountStatus, ProviderQuota } from '../components/account-status.tsx';
import { LoginScopeChip } from '../components/login-scope-chip.tsx';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { OLLAMA_PRESET_ID } from '../lib/local-models.ts';
import { checkLogin, readLogins } from '../lib/logins-api.ts';
import {
  hasSharedEmails,
  HARNESS_NAMES,
  loginEmail,
  loginExplanation,
  loginGroups,
  loginHarnesses,
  loginName,
  loginUse,
  plural,
  signedInSentence,
  slotBadge,
  terminalBadge,
  type UsageBar,
  usageBars,
  usageBarText,
} from '../lib/logins-view.ts';
import { Badge, Button, ChangeApplyPanel, cn } from '../ui.ts';
import { useSignInsLogin } from '../lib/sign-ins-route.ts';
import { AddLoginPanel } from './add-login-panel.tsx';
import {
  authorityRefusal,
  CardSwitch,
  DisableControl,
  LabelEditor,
  RemoveZone,
  SignOutZone,
} from './login-changes-panels.tsx';
import { type LoginChanges, useLoginChanges } from '../lib/login-changes.ts';
import { LocalModelsPanel } from './local-models-panel.tsx';
import { environmentChip, LoginEnvironmentSection } from './login-environment.tsx';
import { LoginSignIn } from './login-sign-in.tsx';
import { useLocalModels } from './use-local-models.ts';

/** The columns every meter on a login shares, so the bars start and end in the same place. */
const METER_LABEL = 'w-12 shrink-0 whitespace-nowrap text-muted';
const METER_WORDS = 'w-48 shrink-0 text-right text-muted';

function UsageBars({ login, now }: { readonly login: LoginView; readonly now: number }) {
  const bars = usageBars(login, now);
  if (bars === null)
    return (
      <p className="m-0 text-meta text-muted" data-login-usage="unknown">
        Usage not measured yet
      </p>
    );
  return (
    <div className="flex flex-col gap-1" data-login-usage="">
      {bars.map((usage: UsageBar) => (
        <div key={usage.label} className="flex min-w-0 items-center gap-2 text-meta">
          <span className={METER_LABEL}>{usage.label}</span>
          <span
            role="img"
            aria-label={usageBarText(usage)}
            className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
          >
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full', usage.high ? 'bg-warn' : 'bg-accent')}
              style={{ width: `${String(usage.percent ?? 0)}%` }}
            />
          </span>
          <span className={METER_WORDS}>
            {usage.percent === null ? 'not measured' : `${String(usage.percent)}% used`}
            {usage.resets === null ? '' : ` · ${usage.resets}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** What a login's quota shows: its provider's reading, or its two windows once it is ready. */
function Quota({ login, now }: { readonly login: LoginView; readonly now: number }) {
  if (login.usage.provider !== undefined) return <ProviderQuota reading={login.usage.provider} now={now} />;
  return login.status.word === 'ready' ? <UsageBars login={login} now={now} /> : null;
}

/** The badges a login carries: its scope, an environment login's preset, its label, a copied slot, the terminal. */
function LoginBadges({ login }: { readonly login: LoginView }) {
  const terminal = terminalBadge(login);
  const slot = slotBadge(login);
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-login-badges="">
      <LoginScopeChip harnesses={loginHarnesses(login)} />
      {login.environment === undefined ? null : (
        <Badge tone="accent" className="max-w-full !whitespace-normal" data-login-environment-chip="">
          {environmentChip(login.environment)}
        </Badge>
      )}
      {login.disabled === undefined ? null : (
        <Badge tone="warn" data-login-disabled-badge="">
          Disabled
        </Badge>
      )}
      {login.label === undefined ? null : <Badge tone="accent">{login.label}</Badge>}
      {slot === null ? null : <Badge className="max-w-full !whitespace-normal">{slot}</Badge>}
      {terminal === null ? null : <Badge className="max-w-full !whitespace-normal">{terminal}</Badge>}
    </span>
  );
}

interface LoginPageProps {
  readonly login: LoginView;
  readonly machineName: string;
  readonly client: LoginsClient;
  readonly reload: () => Promise<void>;
  readonly onBack: () => void;
  readonly now: number;
  readonly clock: () => number;
  readonly pollMs?: number;
}

function LoginPage({ login, machineName, client, reload, onBack, now, clock, pollMs }: LoginPageProps) {
  const changes = useLoginChanges(client);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedInFor, setSignedInFor] = useState<readonly string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const word = checking ? 'checking' : login.status.word;
  const needsSignIn = login.status.word === 'needs_sign_in';
  // An Ollama login lists what Ollama has installed: read once when its page opens, then on Check again.
  const ollama = login.environment?.preset?.id === OLLAMA_PRESET_ID;
  const local = useLocalModels({ client, enabled: ollama });

  const check = async (): Promise<void> => {
    setNotice(null);
    setChecking(true);
    try {
      const checked = await checkLogin(client, login.id);
      setNotice(
        checked.status.word === 'ready' ? 'Checked. The login works.' : `Checked. ${checked.status.explanation}`,
      );
    } catch (error) {
      setNotice(refusalSentence(error));
    } finally {
      setChecking(false);
      await reload();
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-login-page={login.id}>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-page-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Logins
        </Button>
        <h3 className="m-0 mt-2 font-display text-title font-semibold tracking-display text-fg">
          {loginHarnesses(login)
            .map(harness => HARNESS_NAMES[harness])
            .join(' + ')}{' '}
          login
        </h3>
        <p className="m-0 mt-1 break-all font-mono text-cell text-muted">{loginName(login)}</p>
        <div className="mt-2">
          <LoginBadges login={login} />
        </div>
      </div>

      <div className="kt-panel flex flex-col gap-2 p-panel" data-login-status={word}>
        <AccountStatus word={word} showLabel className="text-row font-semibold text-fg" />
        <p className="m-0 text-cell leading-base text-muted">
          {checking ? `Checking with ${HARNESS_NAMES[login.harness]}…` : loginExplanation(login)}
        </p>
        <Quota login={login} now={now} />
      </div>

      {login.environment === undefined ? null : (
        <LoginEnvironmentSection loginId={login.id} environment={login.environment} client={client} online />
      )}

      {ollama ? <LocalModelsPanel machineName={machineName} read={local} onCheck={local.check} /> : null}

      {notice === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-fg" data-login-notice="">
          {notice}
        </p>
      )}

      {signedInFor === null ? null : (
        <div className="kt-panel flex flex-col gap-2 p-panel" role="status" data-login-signed-in="">
          <p className="m-0 text-row font-semibold text-ok">{signedInSentence(signedInFor.length)}</p>
        </div>
      )}

      {needsSignIn ? (
        <LoginSignIn
          login={login}
          machineName={machineName}
          client={client}
          {...(pollMs === undefined ? {} : { pollMs })}
          onSignedIn={() => {
            setSignedInFor(login.usedBy);
            void reload();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3 border-t border-border pt-3" data-login-actions="">
          {login.checkNow.available ? (
            <ChangeApplyPanel
              machineName={machineName}
              authority={changes.authority}
              busy={checking}
              busyLabel="Checking…"
              refusal={null}
              submitLabel="Check now"
              variant="primary"
              onSubmit={() => void check()}
            />
          ) : (
            <p className="m-0 text-cell text-muted">{login.checkNow.reason}</p>
          )}
        </div>
      )}

      <LabelEditor login={login} machineName={machineName} changes={changes} reload={reload} />
      <DisableControl login={login} machineName={machineName} changes={changes} reload={reload} now={clock} />

      <div>
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Used by</h4>
        {login.usedBy.length === 0 ? (
          <p className="mb-0 mt-1 text-cell text-muted">No runtime uses this login yet.</p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {login.usedBy.map(name => (
              <li key={name} className="flex items-center gap-2 text-cell" data-login-runtime={name}>
                <AccountStatus word={login.status.word} />
                <span className="font-mono text-fg">{name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {needsSignIn ? null : <SignOutZone login={login} machineName={machineName} changes={changes} reload={reload} />}
      <RemoveZone
        login={login}
        machineName={machineName}
        changes={changes}
        onRemoved={() => {
          onBack();
          void reload();
        }}
      />
    </section>
  );
}

/** The one act a card can have open: its switch-off form, or its removal's confirmation. */
type CardAct = 'disable' | 'remove';

/**
 * One login's card: the row that opens its page, with the two things v4 kept on the card itself — the on/off switch
 * beside the name and a Remove button under it. Each opens its own confirmation under the card; the page keeps the
 * same acts for a login you are already looking at.
 */
function LoginRow({
  login,
  now,
  clock,
  machineName,
  changes,
  reload,
  open,
  elsewhere,
  onAct,
  onOpen,
}: {
  /** The act open on THIS card, if any: the switch-off form or the removal's confirmation. */
  readonly open: CardAct | null;
  /** Another card has an act open: this card's controls wait for it (one at a time, so a refusal is never shared). */
  readonly elsewhere: boolean;
  readonly onAct: (act: CardAct | null) => void;
  readonly login: LoginView;
  readonly now: number;
  readonly clock: () => number;
  readonly machineName: string;
  readonly changes: LoginChanges;
  readonly reload: () => Promise<void>;
  readonly onOpen: () => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const refusal = authorityRefusal(changes);
  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-login-card-wrap={login.id}>
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 bg-transparent p-0 text-left"
          data-login-card={login.id}
          data-login-row={login.id}
          onClick={onOpen}
        >
          <AccountStatus word={login.status.word} className="mt-1" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-mono text-row text-fg">
              {login.store === 'environment' ? login.id : loginEmail(login)}
            </span>
            <LoginBadges login={login} />
            <span className="text-cell text-muted">
              {login.status.label} · {loginUse(login)}
            </span>
            <Quota login={login} now={now} />
          </span>
        </button>
        <CardSwitch
          login={login}
          changes={changes}
          reload={reload}
          blocked={elsewhere || open === 'remove'}
          asking={open === 'disable'}
          onAsk={asking => onAct(asking ? 'disable' : null)}
          onRefused={setRefused}
        />
        <button
          type="button"
          className="mt-1 shrink-0 border-0 bg-transparent p-0 text-muted"
          aria-label={`Open ${login.id}`}
          onClick={onOpen}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      {refused === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-login-switch-refused="">
          {refused}
        </p>
      )}
      {open === 'disable' && login.disabled === undefined ? (
        <DisableControl
          login={login}
          machineName={machineName}
          changes={changes}
          reload={reload}
          now={clock}
          onDone={() => onAct(null)}
        />
      ) : null}
      {open === 'remove' ? (
        <RemoveZone
          login={login}
          machineName={machineName}
          changes={changes}
          askAtOnce
          onKeep={() => onAct(null)}
          onRemoved={() => {
            onAct(null);
            void reload();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {refusal === null ? null : (
            <span className="min-w-0 flex-1 text-meta leading-base text-muted" data-login-card-locked="">
              Remove is off here: {refusal}
            </span>
          )}
          <Button
            type="button"
            variant="danger"
            size="sm"
            data-login-card-remove={login.id}
            aria-label={`Remove ${login.id}`}
            title={refusal ?? undefined}
            disabled={changes.busy || elsewhere || open === 'disable' || refusal !== null}
            onClick={() => {
              changes.clear();
              setRefused(null);
              onAct('remove');
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

export interface SignInsTabProps {
  readonly client: LoginsClient;
  /** Supplied in tests. */
  readonly now?: () => number;
  readonly pollMs?: number;
  /** The browser whose address names the page to open. Supplied in tests. */
  readonly browser?: Window;
}

type ReadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly list: Awaited<ReturnType<typeof readLogins>> };

export function SignInsTab({ client, now = () => globalThis.Date.now(), pollMs, browser }: SignInsTabProps) {
  const [state, setState] = useState<ReadState>({ kind: 'loading' });
  const [adding, setAdding] = useState(false);
  // The page the address names, and the way the tab opens one: a link from another tab (Runtimes'
  // "Add a new login in Sign-ins", a runtime's login that needs sign-in) lands on the login's page.
  const [detail, openDetail] = useSignInsLogin(state.kind === 'ready' ? state.list.machine : null, browser);
  // One change state for every card on the list: only one act is under way at a time.
  const cardChanges = useLoginChanges(client);
  // The ONE card act open on the list, by login: opening another card's act waits for this one to finish or be cancelled.
  const [cardAct, setCardAct] = useState<{ readonly id: string; readonly act: CardAct } | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', list: await readLogins(client) });
    } catch (error) {
      setState({ kind: 'failed', sentence: refusalSentence(error) });
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.kind === 'loading')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-logins-loading="">
        Reading the logins on this machine…
      </p>
    );
  if (state.kind === 'failed')
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-logins-failed="">
        {state.sentence}
      </p>
    );

  const { list } = state;
  const login = detail === null ? undefined : list.logins.find(item => item.id === detail);
  if (login !== undefined)
    return (
      <LoginPage
        key={login.id}
        login={login}
        machineName={list.machine}
        client={client}
        reload={reload}
        onBack={() => openDetail(null)}
        now={now()}
        clock={now}
        {...(pollMs === undefined ? {} : { pollMs })}
      />
    );

  if (adding)
    return (
      <section className="flex min-w-0 flex-col gap-3" data-logins-adding="">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          onClick={() => setAdding(false)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Logins
        </Button>
        <AddLoginPanel
          client={client}
          onAdded={id => {
            setAdding(false);
            openDetail(id);
            void reload();
          }}
        />
      </section>
    );

  return (
    <section className="flex min-w-0 flex-col gap-4" data-logins-tab="">
      {detail === null ? null : (
        <p role="status" className="m-0 text-cell text-warn" data-login-missing="">
          There is no login {detail} on {list.machine} any more.
        </p>
      )}
      {list.logins.length === 0 ? (
        <div className="kt-panel flex flex-col items-start gap-2 p-panel" data-logins-empty="">
          <h3 className="m-0 text-row font-semibold text-fg">No logins on {list.machine}</h3>
          <p className="m-0 text-cell leading-base text-muted">
            A login is one sign-in or key to Claude Code or Codex. It belongs to this machine.
          </p>
          <Button type="button" variant="primary" data-add-login="" onClick={() => setAdding(true)}>
            Add a login
          </Button>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-cell text-muted">
              {plural(list.logins.length, 'login')} on {list.machine}
            </p>
            <Button type="button" variant="primary" data-add-login="" onClick={() => setAdding(true)}>
              Add a login
            </Button>
          </div>
          {loginGroups(list).map(group => (
            <div key={group.scope} data-logins-group={group.scope}>
              <h4 className="m-0 text-meta font-semibold uppercase text-muted">{group.title}</h4>
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {group.logins.map(item => (
                  <li key={item.id}>
                    <LoginRow
                      login={item}
                      now={now()}
                      clock={now}
                      machineName={list.machine}
                      changes={cardChanges}
                      reload={reload}
                      open={cardAct?.id === item.id ? cardAct.act : null}
                      elsewhere={cardAct !== null && cardAct.id !== item.id}
                      onAct={act => {
                        cardChanges.clear();
                        setCardAct(act === null ? null : { id: item.id, act });
                      }}
                      onOpen={() => {
                        setCardAct(null);
                        openDetail(item.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {hasSharedEmails(list) ? (
            <p className="m-0 text-cell leading-base text-muted" data-logins-labels-hint="">
              Two logins share an email, so each has a label you chose.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
