/**
 * A harness's sign-in, drawn inside that harness's first-run segment (`claude-code.sign-in`, `codex.sign-in`): the
 * login of this harness that still needs signing in, or — on a machine that has none — a button that makes one and
 * starts its sign-in in the same press. Nothing leaves this panel but "signed in": the code or address a person pastes
 * stays inside {@link LoginSignIn}, and no token reaches the page that mounts it (docs/design/harness-login.md).
 */

import { Loading } from '@ferretry/app/ui';
import { createElement, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import type { LoginList } from '../../contract/index.ts';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { useLoginChanges } from '../lib/login-changes.ts';
import { readLogins } from '../lib/logins-api.ts';
import { HARNESS_NAMES, type HarnessKind, suggestLoginId } from '../lib/logins-view.ts';
import { ChangeApplyPanel } from '../ui.ts';
import { LoginSignIn } from './login-sign-in.tsx';

export interface HarnessSignInEmbedProps {
  readonly client: LoginsClient;
  readonly harness: HarnessKind;
  /** Told, with nothing, once the harness accepted the sign-in. */
  readonly onSignedIn?: () => void;
  /** The first read found nothing to ask: the page lifts its loading cover. */
  readonly onShown?: () => void;
  /** The first read found a usable login of this harness: the page may skip itself. */
  readonly onAlreadySignedIn?: () => void;
}

/** `refresh_due` is still a login that works: the harness refreshes it on its own. */
const USABLE: ReadonlySet<string> = new Set(['ready', 'refresh_due']);

/** The login this panel works on: one of this harness that still needs a sign-in. */
const pending = (list: LoginList, harness: HarnessKind) =>
  list.logins.find(login => login.harness === harness && login.status.word === 'needs_sign_in');

export function HarnessSignInEmbed({
  client,
  harness,
  onSignedIn,
  onShown,
  onAlreadySignedIn,
}: HarnessSignInEmbedProps) {
  const changes = useLoginChanges(client);
  const [list, setList] = useState<LoginList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The login this panel just made: its sign-in starts at once, so adding one is not two presses. */
  const [made, setMade] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setList(await readLogins(client));
    } catch (error) {
      setFailure(refusalSentence(error));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Said once, after the first read: a usable login lets the page skip itself, anything else shows the panel.
  const told = useRef(false);
  useEffect(() => {
    if (told.current || (list === null && failure === null)) return;
    told.current = true;
    if (list?.logins.some(login => login.harness === harness && USABLE.has(login.status.word)) === true)
      onAlreadySignedIn?.();
    else onShown?.();
  }, [list, failure, harness, onShown, onAlreadySignedIn]);

  const name = HARNESS_NAMES[harness];
  if (failure !== null)
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn">
        {failure}
      </p>
    );
  if (list === null) return <Loading kind="page" label="Reading the logins on this machine…" />;

  const login = pending(list, harness);
  if (login !== undefined)
    return (
      <LoginSignIn
        login={login}
        machineName={list.machine}
        client={client}
        autoStart={login.id === made}
        onSignedIn={() => {
          void reload();
          onSignedIn?.();
        }}
      />
    );

  if (list.logins.some(item => item.harness === harness))
    return (
      <p className="m-0 text-cell leading-base text-muted" data-harness-sign-in="done">
        {name} is signed in on {list.machine}.
      </p>
    );

  const make = async (): Promise<void> => {
    const id = suggestLoginId(harness, undefined, new Set(list.logins.map(item => item.id)));
    const result = await changes.apply({ kind: 'login.add', id, harness });
    if (result.kind !== 'applied') return;
    setMade(id);
    await reload();
  };

  return (
    <section className="flex flex-col gap-3" data-harness-sign-in={harness}>
      <p className="m-0 text-cell leading-base text-muted">
        There is no {name} sign-in on {list.machine} yet. This makes one and starts signing it in.
      </p>
      <ChangeApplyPanel
        machineName={list.machine}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Adding…"
        refusal={changes.refusal}
        submitLabel={`Sign in to ${name}`}
        onSubmit={() => void make()}
      />
    </section>
  );
}

/** The slot panel: the page that mounts it hands `{ onSignedIn() }`; the props are untyped at the shell, so it checks. */
export function harnessSignIn(
  client: LoginsClient,
  harness: HarnessKind,
  props: Readonly<Record<string, unknown>>,
): ReactElement {
  const callback = (name: string): (() => void) | undefined => {
    const value = props[name];
    return typeof value === 'function' ? () => (value as () => void)() : undefined;
  };
  const [onSignedIn, onShown, onAlreadySignedIn] = [
    callback('onSignedIn'),
    callback('onShown'),
    callback('onAlreadySignedIn'),
  ];
  return createElement(HarnessSignInEmbed, {
    client,
    harness,
    ...(onSignedIn === undefined ? {} : { onSignedIn }),
    ...(onShown === undefined ? {} : { onShown }),
    ...(onAlreadySignedIn === undefined ? {} : { onAlreadySignedIn }),
  });
}
