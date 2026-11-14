/**
 * The acts that change ONE login, on its page (today's Label, Switch off / on, Sign out and Remove): each says WHICH
 * change to make, stages it at Logins' own route and shows the daemon's own consequences before anything that removes
 * or signs out. `ChangeApplyPanel` is the last thing each shows: the button, the passkey sentence, the grant guidance.
 */
import { useEffect, useRef, useState } from 'react';
import { changeRefusalExplanation, cn } from '../ui.ts';
import type { LoginChangeView, LoginView } from '../../contract/index.ts';
import type { LoginChanges } from '../lib/login-changes.ts';
import { Button, ChangeApplyPanel } from '../ui.ts';
import { HARNESS_NAMES } from '../lib/logins-view.ts';

const SIGN_OUT_VERSUS_REMOVE = 'Sign out keeps the login but it needs sign-in again. Remove deletes it.';

/**
 * Why this caller can never change a login from here, or `null`. Only a refusal a passkey would not fix counts: a step-up
 * is asked for by the carrier when the change applies, so the controls stay on for it.
 */
export const authorityRefusal = (changes: LoginChanges): string | null =>
  changes.authority?.kind === 'refused' ? changeRefusalExplanation(changes.authority.refusal) : null;

interface PanelProps {
  readonly login: LoginView;
  readonly machineName: string;
  readonly changes: LoginChanges;
  readonly reload: () => Promise<void>;
}

/** A label that tells logins with the same email apart. Only the person who chose it sees it. */
export function LabelEditor({ login, machineName, changes, reload }: PanelProps) {
  const [label, setLabel] = useState(login.label ?? '');
  const unchanged = label.trim() === (login.label ?? '');
  const save = async (): Promise<void> => {
    const trimmed = label.trim();
    const result = await changes.apply({ kind: 'login.label', id: login.id, label: trimmed === '' ? null : trimmed });
    if (result.kind === 'applied') await reload();
  };
  return (
    <div className="flex flex-col gap-2" data-login-label="">
      <label htmlFor={`login-label-${login.id}`} className="text-ui font-semibold text-fg">
        Label
      </label>
      <input
        id={`login-label-${login.id}`}
        className="kt-input"
        autoComplete="off"
        value={label}
        placeholder="e.g. personal or work"
        onChange={event => setLabel(event.target.value)}
      />
      <span className="text-meta leading-base text-muted">
        Only you see this. It tells logins with the same email apart.
      </span>
      {login.needsLabel ? (
        <span className="text-meta leading-base text-warn" data-login-needs-label="">
          Another {HARNESS_NAMES[login.harness]} login here has the same email. Give each a different label.
        </span>
      ) : null}
      {unchanged ? null : (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save label"
          onSubmit={() => void save()}
        />
      )}
    </div>
  );
}

const WAITS: readonly { readonly id: string; readonly label: string; readonly ms: number | null }[] = [
  { id: 'until-on', label: 'Until I switch it back on', ms: null },
  { id: '1h', label: 'For an hour', ms: 3_600_000 },
  { id: '1d', label: 'For a day', ms: 86_400_000 },
  { id: '1w', label: 'For a week', ms: 604_800_000 },
];

/** Switch the login off without deleting it, or back on. Nothing running is stopped. */
export function DisableControl({
  login,
  machineName,
  changes,
  reload,
  now,
  onDone,
}: PanelProps & {
  readonly now: () => number;
  /** Called once a switch-off or switch-on has applied (held for the owner included), so a card can close its form. */
  readonly onDone?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [wait, setWait] = useState('until-on');
  const off = login.disabled !== undefined;
  const toggle = async (): Promise<void> => {
    const ms = WAITS.find(entry => entry.id === wait)?.ms ?? null;
    const trimmed = reason.trim();
    const result = await changes.apply(
      off
        ? { kind: 'login.enable', id: login.id }
        : {
            kind: 'login.disable',
            id: login.id,
            ...(trimmed === '' ? {} : { reason: trimmed }),
            ...(ms === null ? {} : { until: new Date(now() + ms).toISOString() as never }),
          },
    );
    if (result.kind === 'applied') {
      setReason('');
      setWait('until-on');
      await reload();
      onDone?.();
    }
  };
  return (
    <div className="flex flex-col gap-2" data-login-disable={off ? 'off' : 'on'}>
      {off ? (
        <p className="m-0 text-cell leading-base text-warn" data-login-disabled-note="">
          Switched off{login.disabled?.reason === undefined ? '' : `: ${login.disabled.reason}`}. Nothing new starts on
          it; ferrets already on it keep going.
        </p>
      ) : (
        <>
          <label htmlFor={`login-disable-reason-${login.id}`} className="text-ui font-semibold text-fg">
            Switch off
          </label>
          <input
            id={`login-disable-reason-${login.id}`}
            className="kt-input"
            autoComplete="off"
            value={reason}
            placeholder="Why (optional)"
            onChange={event => setReason(event.target.value)}
          />
          <select
            className="kt-input"
            value={wait}
            aria-label="For how long"
            onChange={event => setWait(event.target.value)}
          >
            {WAITS.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </>
      )}
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={off ? 'Switch back on' : 'Switch off'}
        onSubmit={() => void toggle()}
      />
    </div>
  );
}

/** Sign out: the harness's own logout. Asks first, with the daemon's own sentence about who else it signs out. */
export function SignOutZone({ login, machineName, changes, reload }: PanelProps) {
  const [asking, setAsking] = useState(false);
  if (!login.signOut.available) return null;
  const signOut = async (): Promise<void> => {
    const result = await changes.apply({ kind: 'login.signout', id: login.id });
    // A sign-out the harness could not do keeps the card open, with its reason, so the person sees it failed.
    if (result.kind === 'applied') {
      if (result.outcome.outcome === 'signed-out') setAsking(false);
      await reload();
    }
  };
  return asking ? (
    <div role="alert" className="kt-panel flex flex-col gap-3 p-panel" data-login-sign-out="">
      <p className="m-0 text-row font-semibold text-fg">{login.signOut.sentence}</p>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Signing out…"
        refusal={changes.refusal}
        submitLabel="Sign out"
        variant="danger"
        onSubmit={() => void signOut()}
      >
        <Button type="button" data-sign-out-keep="" onClick={() => setAsking(false)}>
          Keep signed in
        </Button>
      </ChangeApplyPanel>
    </div>
  ) : (
    <div>
      <Button
        type="button"
        variant="ghost"
        className="kt-btn--flush-start"
        data-login-sign-out-ask=""
        onClick={() => {
          changes.clear();
          setAsking(true);
        }}
      >
        Sign out…
      </Button>
    </div>
  );
}

/** Remove: stages the change first so the daemon's own consequences are on screen before the person confirms. */
export function RemoveZone({
  login,
  machineName,
  changes,
  onRemoved,
  askAtOnce = false,
  onKeep,
}: Omit<PanelProps, 'reload'> & {
  readonly onRemoved: () => void;
  /** A card's own Remove button already asked: stage at once instead of waiting for a second click. */
  readonly askAtOnce?: boolean;
  /** Called when the person keeps the login, so a card can fold the confirmation away. */
  readonly onKeep?: () => void;
}) {
  // A card's confirmation has a way out in every state: reading what removing it does, refused, and asking to confirm.
  const onCard = askAtOnce && onKeep !== undefined;
  const [staged, setStaged] = useState<LoginChangeView | null>(null);
  const ask = async (): Promise<void> => {
    const result = await changes.stage({ kind: 'login.remove', id: login.id });
    if (result.kind === 'staged') setStaged(result.staged);
  };
  // Once, when the card asks: a later render must not stage the same removal again.
  const asked = useRef(false);
  useEffect(() => {
    if (!askAtOnce || asked.current) return;
    asked.current = true;
    void ask();
  });
  const remove = async (): Promise<void> => {
    if (staged === null) return;
    const result = await changes.applyStaged(staged);
    if (result.kind === 'applied') {
      setStaged(null);
      onRemoved();
    }
  };
  return (
    <div className="flex flex-col items-start gap-2 border-t border-border pt-3" data-login-remove-zone="">
      <p className="m-0 text-meta leading-base text-muted" data-login-remove-hint="">
        {SIGN_OUT_VERSUS_REMOVE}
      </p>
      {staged === null ? (
        <>
          {onCard ? (
            <div className="flex flex-wrap items-center gap-2" data-login-remove-pending="">
              {changes.busy ? <span className="text-cell text-muted">Checking what removing it does…</span> : null}
              <Button
                type="button"
                data-login-remove-keep=""
                onClick={() => {
                  changes.clear();
                  onKeep?.();
                }}
              >
                {changes.busy ? 'Cancel' : 'Keep it'}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="danger"
              data-login-remove-ask=""
              disabled={changes.busy}
              onClick={() => void ask()}
            >
              Remove this login…
            </Button>
          )}
          {changes.refusal === null ? null : (
            <p role="alert" className="m-0 text-cell leading-base text-err" data-change-refusal="">
              {changes.refusal}
            </p>
          )}
        </>
      ) : (
        <div role="alert" className="kt-panel flex w-full flex-col gap-3 p-panel" data-login-remove="">
          <p className="m-0 text-row font-semibold text-fg">{staged.summary}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-cell leading-base text-muted">
            {staged.consequences.map(sentence => (
              <li key={sentence}>• {sentence}</li>
            ))}
          </ul>
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={changes.busy}
            busyLabel="Removing…"
            refusal={changes.refusal}
            submitLabel="Remove"
            variant="danger"
            onSubmit={() => void remove()}
          >
            <Button
              type="button"
              data-login-remove-keep=""
              onClick={() => {
                changes.clear();
                setStaged(null);
                onKeep?.();
              }}
            >
              Keep it
            </Button>
          </ChangeApplyPanel>
        </div>
      )}
    </div>
  );
}

/**
 * The switch on a login's card (docs/disabling.md): on, a tap asks for a reason and how long (the form is the
 * page's `DisableControl`, shown by the card); off, a tap switches it back on at once. Switching on only ever loosens
 * back to what was there and switching off tightens, so neither asks "are you sure". Nothing running is stopped.
 */
export function CardSwitch({
  login,
  changes,
  reload,
  asking,
  onAsk,
  onRefused,
  blocked = false,
}: Omit<PanelProps, 'machineName'> & {
  /** Another card's act is open: this switch waits for it to finish or be cancelled. */
  readonly blocked?: boolean;
  readonly asking: boolean;
  readonly onAsk: (asking: boolean) => void;
  /** Said where the card shows it, when switching back on is refused. */
  readonly onRefused: (sentence: string | null) => void;
}) {
  const off = login.disabled !== undefined;
  // Only a refusal a passkey would not fix locks the switch; a step-up is asked for by the carrier when it applies.
  const refusal = authorityRefusal(changes);
  const toggle = async (): Promise<void> => {
    changes.clear();
    onRefused(null);
    if (!off) return onAsk(!asking);
    const result = await changes.apply({ kind: 'login.enable', id: login.id });
    if (result.kind === 'applied') await reload();
    else onRefused(result.sentence);
  };
  return (
    <span
      className="relative z-10 inline-flex shrink-0"
      data-login-switch={login.id}
      data-login-switch-state={off ? 'off' : 'on'}
    >
      <button
        type="button"
        role="switch"
        aria-checked={!off}
        aria-label={`${login.id}: ${off ? 'off' : 'on'} for new starts`}
        disabled={changes.busy || blocked || refusal !== null}
        title={refusal ?? undefined}
        onClick={() => void toggle()}
        className="-my-3 inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span
          aria-hidden="true"
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
            off ? 'border-border-strong bg-surface-2' : 'border-accent bg-accent',
          )}
        >
          <span
            className={cn(
              'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-transform',
              off ? 'translate-x-[2px] bg-muted' : 'translate-x-[18px] bg-accent-fg',
            )}
          />
        </span>
      </button>
    </span>
  );
}
