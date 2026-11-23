/**
 * The Sign-ins tab (docs/design/account-model.md §4.2): the logins kept on this machine, grouped by harness, each
 * with its status, its usage and who uses it — and each login's own page, where it is checked, signed in and (for an
 * environment login) tested.
 *
 * One page is one login. This screen reads and acts through Logins' own routes only (`GET /v1/logins`, check, test,
 * sign-in, local models, and the login change routes: add, label, switch off or on, sign out, remove). Every act that
 * changes the machine ends in a `ChangeApplyPanel`, so a caller that may not change it is told why before it clicks.
 */

import { Loading } from '@ferretry/app/ui';
import { daemonOfClient, PanelSlot, useSlotHasUsablePanels } from '@ferretry/app';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LOGIN_METER_SLOT, type LoginView } from '../../contract/index.ts';
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
import { Badge, Button, ChangeApplyPanel, cn, InlineCode } from '../ui.ts';
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

/** An email that may wrap AFTER its "@" (and nowhere inside a word) when the card is narrow. */
function breakAtAt(email: string) {
  const at = email.indexOf('@');
  return at < 0 ? (
    email
  ) : (
    <>
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </>
  );
}

/** The columns every meter on a login shares, so the bars start and end in the same place. */
const METER_LABEL = 'w-12 shrink-0 whitespace-nowrap text-muted';
// On a narrow panel the words sit beside the label and the bar takes the full width below them; from a 480px panel (container query in logins.css, never the window) all three share a row.
const METER_ROW = 'fy-lg-meter flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta';
const METER_BAR = 'fy-lg-meter__bar order-last basis-full';
// `basis-0` keeps the words on the label's line on a phone (they wrap inside their share) rather than dropping to a line of their own.
const METER_WORDS = 'fy-lg-meter__words min-w-0 flex-1 basis-0 text-right text-muted';

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
        <div key={usage.label} className={METER_ROW}>
          <span className={METER_LABEL}>{usage.label}</span>
          <span
            role="img"
            aria-label={usageBarText(usage)}
            className={cn('relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2', METER_BAR)}
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

/**
 * Where a login stands against its spend budget (v4's "$/day" and "$/week" bars): the panel Usage contributes to
 * `logins.login-meter`, handed the budget the list carries. Nothing is drawn for a login with no budget, or where no
 * panel is placed or usable on this machine.
 */
function BudgetMeter({
  login,
  daemon,
  machineName,
}: {
  readonly login: LoginView;
  readonly daemon: string | undefined;
  readonly machineName: string;
}) {
  const usable = useSlotHasUsablePanels(daemon ?? '', LOGIN_METER_SLOT);
  if (login.budget === undefined || daemon === undefined || !usable) return null;
  return (
    <PanelSlot
      daemon={daemon}
      slot={LOGIN_METER_SLOT}
      subject={login.id}
      props={{ budget: login.budget, machineName }}
    />
  );
}

/** What a login's quota shows: its provider's reading, or its two windows once it is ready, then its spend budget. */
function Quota({
  login,
  now,
  daemon,
  machineName,
}: {
  readonly login: LoginView;
  readonly now: number;
  readonly daemon: string | undefined;
  readonly machineName: string;
}) {
  const quota =
    login.usage.provider !== undefined ? (
      <ProviderQuota reading={login.usage.provider} now={now} />
    ) : login.status.word === 'ready' ? (
      <UsageBars login={login} now={now} />
    ) : null;
  return (
    <div className="flex min-w-0 max-w-xl flex-col gap-2">
      {quota}
      <BudgetMeter login={login} daemon={daemon} machineName={machineName} />
    </div>
  );
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
      {login.label === undefined ? null : (
        <Badge
          tone="accent"
          className="max-w-full !whitespace-normal [overflow-wrap:anywhere]"
          data-login-label-badge=""
        >
          {login.label}
        </Badge>
      )}
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
  const daemon = daemonOfClient(client);
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
    <section className="fy-lg-groups min-w-0" data-login-page={login.id}>
      <div className="fy-lg-group">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start self-start"
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

      <div className="fy-lg-group" data-login-status={word}>
        <AccountStatus word={word} showLabel className="text-row font-semibold text-fg" />
        <p className="m-0 text-cell leading-base text-muted">
          {checking ? (
            <Loading kind="bar" label={`Checking with ${HARNESS_NAMES[login.harness]}…`} />
          ) : (
            loginExplanation(login)
          )}
        </p>
        <Quota login={login} now={now} daemon={daemon} machineName={machineName} />
      </div>

      {login.environment === undefined ? null : (
        <LoginEnvironmentSection
          loginId={login.id}
          environment={login.environment}
          client={client}
          online
          machineName={machineName}
          changes={changes}
          reload={reload}
        />
      )}

      {ollama ? <LocalModelsPanel machineName={machineName} read={local} onCheck={local.check} /> : null}

      {notice === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-fg" data-login-notice="">
          {notice}
        </p>
      )}

      {signedInFor === null ? null : (
        <div className="flex flex-col gap-2" role="status" data-login-signed-in="">
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
        <div className="flex flex-col gap-3" data-login-actions="">
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

      <div className="fy-lg-group">
        <LabelEditor login={login} machineName={machineName} changes={changes} reload={reload} />
        <DisableControl login={login} machineName={machineName} changes={changes} reload={reload} now={clock} />
      </div>

      <div className="fy-lg-group">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Used by</h4>
        {/* A count, not the runtimes' stored names: those mean nothing to a person. The names stay one hover away. */}
        <p
          className="mb-0 mt-1 text-cell text-muted"
          data-login-used-by=""
          {...(login.usedBy.length === 0 ? {} : { title: login.usedBy.join(', ') })}
        >
          {login.usedBy.length === 0 ? 'No runtime uses this login yet.' : loginUse(login)}
        </p>
      </div>

      <div className="fy-lg-group">
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
      </div>
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
  daemon,
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
  /** The machine this card is on, which a contributed panel is addressed through. */
  readonly daemon: string | undefined;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const refusal = authorityRefusal(changes);
  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-login-card-wrap={login.id}>
      <div className="relative flex min-w-0 items-start gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 bg-transparent p-0 text-left"
          data-login-card={login.id}
          data-login-row={login.id}
          onClick={onOpen}
        >
          <AccountStatus word={login.status.word} className="mt-1" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="block min-h-9 break-words pr-24 font-mono text-row text-fg">
              {login.store === 'environment' ? login.id : breakAtAt(loginEmail(login))}
            </span>
            <LoginBadges login={login} />
            <span className="text-cell text-muted">
              {login.status.label} · {loginUse(login)}
            </span>
            <Quota login={login} now={now} daemon={daemon} machineName={machineName} />
          </span>
        </button>
        <span className="absolute right-0 top-0 z-10 flex items-center gap-2" data-login-card-controls="">
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
            className="inline-flex min-h-[44px] min-w-[28px] shrink-0 items-center justify-center gap-1 border-0 bg-transparent p-0 text-meta text-muted"
            aria-label={`Open ${login.id}`}
            onClick={onOpen}
          >
            Open
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </span>
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
        <div className="mt-auto flex flex-wrap items-center justify-end gap-2" data-login-card-footer="">
          {refusal === null ? null : (
            <span className="min-w-0 flex-1 text-meta leading-base text-muted" data-login-card-locked="">
              Remove is off here: <InlineCode text={refusal} />
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-err"
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

/** The tab, in the container its columns are measured against (the Settings panel's width, never the window's). */
export function SignInsTab(props: SignInsTabProps) {
  return (
    <div className="fy-lg">
      <SignInsBody {...props} />
    </div>
  );
}

function SignInsBody({ client, now = () => globalThis.Date.now(), pollMs, browser }: SignInsTabProps) {
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

  if (state.kind === 'loading') return <Loading kind="page" label="Reading the logins on this machine…" />;
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
      <section className="fy-lg-group" data-logins-adding="">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start self-start"
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
    <section className="fy-lg-groups min-w-0" data-logins-tab="">
      {detail === null ? null : (
        <p role="status" className="m-0 text-cell text-warn" data-login-missing="">
          There is no login {detail} on {list.machine} any more.
        </p>
      )}
      {list.logins.length === 0 ? (
        <div className="flex max-w-xl flex-col items-start gap-2 py-4" data-logins-empty="">
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
          <div className="fy-lg-group" data-logins-heading="">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 text-cell leading-base text-muted">
                Each login is one sign-in or key to Claude Code or Codex, and belongs to this machine.
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <p className="m-0 text-cell text-muted">
                {plural(list.logins.length, 'login')} on {list.machine}
              </p>
              <Button type="button" variant="primary" data-add-login="" onClick={() => setAdding(true)}>
                Add a login
              </Button>
            </div>
          </div>
          {loginGroups(list).map(group => (
            <div key={group.scope} className="fy-lg-group" data-logins-group={group.scope}>
              <h4 className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">{group.title}</h4>
              <ul className="fy-lg-cards">
                {group.logins.map(item => (
                  <li key={item.id} className="min-w-0">
                    <LoginRow
                      login={item}
                      daemon={daemonOfClient(client)}
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
