/**
 * Remove one login (docs/account-model.md "Removing a login"): the dialog the Remove button on a
 * login's row and page opens.
 *
 * It shows its impact FIRST, from the daemon's dry run: which runtimes use the login and how many
 * ferrets are running on them (they keep running). Each runtime gets a choice — switch to another
 * login that drives the same CLI (the default when one exists) or remove the runtime too — and every
 * choice restages the real change, so what the daemon says is what pressing the button does.
 * Everything goes in ONE change the daemon applies atomically.
 *
 * Removing forgets the login; it never touches credential material. A saved sign-in is deleted only
 * when the person ticks "sign it out too", which runs the existing sign-out first. No secret value is
 * shown, copied or sent here: the secrets a login named stay in the secret store, listed by name.
 */

import type {
  FleetAccountChange,
  FleetAccountChangeView,
  FleetCredentialView,
  FleetMachineView,
  FleetRunningSession,
  FleetRuntimeView,
} from '@ferretry/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { moveConversation } from '../runtimes/runtime-actions-model.ts';
import { RuntimeDialog, WRAPPING_SUBMIT } from '../runtimes/runtime-actions.tsx';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import {
  canSignOutFirst,
  confirmLabel,
  defaultChoices,
  ferretsOnLogin,
  ferretsOnRemoved,
  initialChoices,
  moveTargetsFor,
  removeChange,
  removesDefault,
  type RuntimeChoice,
  type RuntimeChoices,
  runtimesOnLogin,
  SIGN_OUT_VERSUS_REMOVE,
  signOutWarning,
  switchTargets,
  usedBySentence,
} from './login-remove-model.ts';

export interface RemoveLoginDialogProps {
  readonly credential: FleetCredentialView;
  readonly credentials: readonly FleetCredentialView[];
  readonly runtimes: readonly FleetRuntimeView[];
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly onClose: () => void;
  /** The login is gone (and whatever was asked of its runtimes is done). */
  readonly onRemoved: () => void;
}

type Staging =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid'; readonly sentence: string }
  | { readonly kind: 'refused'; readonly key: string }
  | { readonly kind: 'staged'; readonly key: string; readonly staged: FleetAccountChangeView };

/** A ferret that could not be moved, and why. */
interface MoveFailure {
  readonly session: FleetRunningSession;
  readonly sentence: string;
}

export function RemoveLoginDialog({
  credential,
  credentials,
  runtimes,
  machine,
  machineName,
  changes,
  connection,
  createClient,
  onClose,
  onRemoved,
}: RemoveLoginDialogProps) {
  const users = runtimesOnLogin(credential, runtimes);
  const [choices, setChoices] = useState<RuntimeChoices>(() => initialChoices(credential, users, credentials));
  const [newDefault, setNewDefault] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [signOutFirst, setSignOutFirst] = useState(false);
  const [canMove, setCanMove] = useState(false);
  const [staging, setStaging] = useState<Staging>({ kind: 'reading' });
  const [working, setWorking] = useState<'signing-out' | 'moving' | 'removing' | null>(null);
  const [failures, setFailures] = useState<readonly MoveFailure[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef(changes);
  latest.current = changes;

  const needsDefault = removesDefault(choices, machine);
  const defaults = defaultChoices(choices, runtimes);
  const pickedDefault = needsDefault
    ? newDefault !== null && defaults.some(r => r.name === newDefault)
      ? newDefault
      : (defaults[0]?.name ?? null)
    : null;
  const stuck = needsDefault && pickedDefault === null;
  const change: FleetAccountChange = removeChange(credential, choices, pickedDefault);
  const key = JSON.stringify(change);

  // The dry run, read again for every choice: what removing it WITH these choices would do.
  useEffect(() => {
    if (stuck) {
      setStaging({
        kind: 'invalid',
        sentence:
          'There is no other agent runtime to make the default. Switch it to another login or add a runtime first.',
      });
      return;
    }
    let live = true;
    void latest.current.stage(JSON.parse(key) as FleetAccountChange).then(result => {
      if (!live) return;
      setStaging(result.kind === 'staged' ? { kind: 'staged', key, staged: result.staged } : { kind: 'refused', key });
    });
    return () => {
      live = false;
    };
  }, [key, stuck]);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(client => typeof client.migrate === 'function')
      .catch(() => false)
      .then(offered => {
        if (live) setCanMove(offered);
      });
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const staged = staging.kind === 'staged' ? staging.staged : null;
  const current = staging.kind === 'staged' && staging.key === key;
  const ferrets = ferretsOnLogin(staged);
  const toMove = ferretsOnRemoved(staged, choices);
  const targets = moveTargetsFor(choices, runtimes);
  const moveTarget = targets.find(candidate => candidate.name === moveTo) ?? null;
  const moving = moveTarget === null ? 0 : toMove.length;
  const busy = working !== null;
  const canSignOut = canSignOutFirst(credential);

  const choose = (name: string, choice: RuntimeChoice): void => {
    setChoices(previous => ({ ...previous, [name]: choice }));
    setNewDefault(null);
    setMoveTo(null);
    setFailures([]);
    setNote(null);
  };

  const moveAll = async (destination: FleetRuntimeView): Promise<readonly MoveFailure[]> => {
    const client = await createClient(connection);
    const missed: MoveFailure[] = [];
    for (const session of toMove) {
      try {
        if (client.migrate === undefined) throw new Error('This app cannot move a ferret on this machine.');
        await client.migrate(
          session.id,
          destination.name,
          undefined,
          false,
          undefined,
          false,
          moveConversation(session, destination),
        );
      } catch (error) {
        missed.push({ session, sentence: changeRefusalSentence(error) });
      }
    }
    return missed;
  };

  const confirm = async (): Promise<void> => {
    if (staging.kind !== 'staged' || !current) return;
    setNote(null);
    let signedOut = false;
    try {
      if (signOutFirst && canSignOut) {
        setWorking('signing-out');
        const out = await changes.apply({ kind: 'credential.signout', id: credential.id });
        if (out.kind === 'refused') return;
        if (out.outcome.outcome === 'sign-out-failed') {
          setNote(`${credential.id} was not removed: ${out.outcome.reason}`);
          return;
        }
        signedOut = true;
      }
      if (moveTarget !== null && toMove.length > 0) {
        setWorking('moving');
        const missed = await moveAll(moveTarget);
        setFailures(missed);
        if (missed.length > 0) {
          setMoveTo(null);
          if (signedOut) setNote(`${credential.id} is signed out, but it was not removed.`);
          return;
        }
      }
      setWorking('removing');
      // Sign-out and moves took a while, so the removal is staged afresh rather than applying a preview that
      // may have expired.
      const result = signedOut || moving > 0 ? await changes.apply(change) : await changes.applyStaged(staging.staged);
      if (result.kind === 'refused') {
        if (signedOut) setNote(`${credential.id} is signed out, but it was not removed.`);
        return;
      }
      onRemoved();
    } finally {
      setWorking(null);
    }
  };

  const label = confirmLabel(
    credential,
    choices,
    { count: moving, to: moveTarget?.name ?? null },
    signOutFirst && canSignOut,
  );
  const cancel = (
    <Button type="button" variant="ghost" disabled={busy} onClick={onClose} data-runtime-dialog-cancel="">
      Cancel
    </Button>
  );

  return (
    <RuntimeDialog title={`Remove ${credential.id}?`} name="remove-login" busy={busy} onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-login-remove-body="">
        <p className="m-0 text-cell font-semibold leading-base text-fg" data-login-remove-used="">
          {usedBySentence(users)}
        </p>

        {users.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-login-remove-runtimes="">
            {users.map(runtime => (
              <RuntimeChoiceRow
                key={runtime.name}
                runtime={runtime}
                isDefault={machine?.defaultRuntime === runtime.name}
                options={switchTargets(credential, runtime, credentials)}
                choice={choices[runtime.name] ?? { kind: 'remove' }}
                disabled={busy}
                onChoose={choice => choose(runtime.name, choice)}
              />
            ))}
          </ul>
        )}

        {!needsDefault || defaults.length === 0 ? null : (
          <DefaultPick
            machineName={machineName}
            defaults={defaults}
            value={pickedDefault ?? ''}
            disabled={busy}
            onChange={setNewDefault}
          />
        )}

        {staging.kind === 'reading' ? (
          <p role="status" className="m-0 text-cell text-muted" data-login-remove-reading="">
            Checking what runs on {credential.id}…
          </p>
        ) : staging.kind === 'invalid' ? (
          <p role="alert" className="m-0 text-cell leading-base text-err" data-login-remove-invalid="">
            {staging.sentence}
          </p>
        ) : staged === null ? null : (
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0 text-cell leading-base text-fg"
            data-login-remove-impact=""
            aria-busy={!current}
          >
            {staged.consequences.map(sentence => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        )}

        {toMove.length === 0 ? null : (
          <MoveFerrets
            running={toMove}
            targets={canMove ? targets : []}
            value={moveTo}
            disabled={busy}
            onChange={value => {
              setMoveTo(value);
              setFailures([]);
            }}
          />
        )}

        {failures.length === 0 ? null : (
          <div role="alert" className="flex flex-col gap-1 text-cell leading-base text-err" data-runtime-move-failed="">
            <p className="m-0 font-semibold">
              {failures.length === 1 ? 'One ferret' : `${String(failures.length)} ferrets`} could not be moved, so{' '}
              {credential.id} was not removed.
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {failures.map(failure => (
                <li key={failure.session.id}>
                  <span className="font-semibold">{failure.session.name}</span>: {failure.sentence}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canSignOut ? (
          <div className="flex flex-col gap-1">
            <label className="flex min-h-control items-center gap-2 text-cell text-fg">
              <input
                type="checkbox"
                className="shrink-0 accent-[var(--accent)]"
                checked={signOutFirst}
                disabled={busy}
                data-login-remove-sign-out=""
                onChange={event => setSignOutFirst(event.currentTarget.checked)}
              />
              Sign it out first, so its saved sign-in is deleted
            </label>
            {signOutFirst && signOutWarning(ferrets) !== null ? (
              <p className="m-0 text-meta leading-base text-warn" data-login-remove-sign-out-warning="">
                {signOutWarning(ferrets)}
              </p>
            ) : null}
          </div>
        ) : null}

        {note === null ? null : (
          <p role="alert" className="m-0 text-cell leading-base text-err" data-login-remove-note="">
            {note}
          </p>
        )}

        <p className="m-0 text-meta leading-base text-muted" data-login-remove-difference="">
          {SIGN_OUT_VERSUS_REMOVE}
        </p>
      </div>

      <div className="shrink-0 border-t border-border-soft pt-3">
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={busy}
          refusal={changes.refusal}
          submitLabel={label}
          busyLabel={working === 'signing-out' ? 'Signing out…' : working === 'moving' ? 'Moving…' : 'Removing…'}
          variant="danger"
          submitClassName={WRAPPING_SUBMIT}
          disabled={!current}
          onSubmit={() => void confirm()}
        >
          {cancel}
        </ChangeApplyPanel>
      </div>
    </RuntimeDialog>
  );
}

function RuntimeChoiceRow({
  runtime,
  isDefault,
  options,
  choice,
  disabled,
  onChoose,
}: {
  readonly runtime: FleetRuntimeView;
  readonly isDefault: boolean;
  readonly options: readonly FleetCredentialView[];
  readonly choice: RuntimeChoice;
  readonly disabled: boolean;
  readonly onChoose: (choice: RuntimeChoice) => void;
}) {
  const group = useId();
  const selectId = useId();
  const first = options[0];
  return (
    <li>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-1 rounded-control border border-border-soft p-3"
        data-login-remove-runtime={runtime.name}
      >
        <legend className="px-1 text-cell">
          <span className="font-mono font-semibold text-fg">{runtime.name}</span>
          <span className="text-muted">
            {' '}
            · {HARNESS_NAMES[runtime.harness]}
            {isDefault ? ' · default' : ''}
          </span>
        </legend>
        <label className="flex min-h-control items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={group}
            className="shrink-0 accent-[var(--accent)]"
            checked={choice.kind === 'switch'}
            disabled={disabled || first === undefined}
            data-login-remove-switch={runtime.name}
            onChange={() => first !== undefined && onChoose({ kind: 'switch', to: first.id })}
          />
          Switch to
        </label>
        {first === undefined ? (
          <p className="m-0 pl-6 text-meta leading-base text-muted" data-login-remove-no-target="">
            There is no other {HARNESS_NAMES[runtime.harness]} login to switch to.
          </p>
        ) : (
          <select
            id={selectId}
            aria-label={`Login ${runtime.name} switches to`}
            className="kt-input"
            value={choice.kind === 'switch' ? choice.to : first.id}
            disabled={disabled || choice.kind !== 'switch'}
            data-login-remove-target={runtime.name}
            onChange={event => onChoose({ kind: 'switch', to: event.currentTarget.value })}
          >
            {options.map(login => (
              <option key={login.id} value={login.id}>
                {login.id}
              </option>
            ))}
          </select>
        )}
        <label className="flex min-h-control items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={group}
            className="shrink-0 accent-[var(--accent)]"
            checked={choice.kind === 'remove'}
            disabled={disabled}
            data-login-remove-runtime-too={runtime.name}
            onChange={() => onChoose({ kind: 'remove' })}
          />
          Remove the runtime too
        </label>
      </fieldset>
    </li>
  );
}

function DefaultPick({
  machineName,
  defaults,
  value,
  disabled,
  onChange,
}: {
  readonly machineName: string;
  readonly defaults: readonly FleetRuntimeView[];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (name: string) => void;
}) {
  const selectId = useId();
  return (
    <div className="flex flex-col gap-1" data-login-remove-default="">
      <label htmlFor={selectId} className="text-cell font-semibold text-fg">
        New default runtime
      </label>
      <select
        id={selectId}
        className="kt-input"
        value={value}
        disabled={disabled}
        data-login-remove-default-picker=""
        onChange={event => onChange(event.currentTarget.value)}
      >
        {defaults.map(runtime => (
          <option key={runtime.name} value={runtime.name}>
            {runtime.name} · {HARNESS_NAMES[runtime.harness]}
          </option>
        ))}
      </select>
      <span className="text-meta leading-base text-muted">
        A runtime you are removing is {machineName}’s default for new agents.
      </span>
    </div>
  );
}

function MoveFerrets({
  running,
  targets,
  value,
  disabled,
  onChange,
}: {
  readonly running: readonly FleetRunningSession[];
  readonly targets: readonly FleetRuntimeView[];
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (target: string | null) => void;
}) {
  const selectId = useId();
  return (
    <div className="flex flex-col gap-2" data-login-remove-ferrets="">
      <ul
        aria-label="Ferrets on the runtimes being removed"
        className="m-0 flex max-h-[24dvh] list-none flex-col divide-y divide-border-soft overflow-y-auto rounded-control border border-border-soft p-0"
      >
        {running.map(session => (
          <li key={session.id} className="flex min-h-[44px] min-w-0 items-center gap-2 px-3 py-2 text-cell">
            <span className="min-w-0 flex-1 truncate font-semibold text-fg">{session.name}</span>
            <span className="shrink-0 text-meta text-muted">{session.runtime}</span>
          </li>
        ))}
      </ul>
      {targets.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-cell font-semibold text-fg">
            Move them to…
          </label>
          <select
            id={selectId}
            className="kt-input"
            value={value ?? ''}
            disabled={disabled}
            data-runtime-move-target=""
            onChange={event => onChange(event.currentTarget.value === '' ? null : event.currentTarget.value)}
          >
            <option value="">Leave them running here</option>
            {targets.map(candidate => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {HARNESS_NAMES[candidate.harness]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
