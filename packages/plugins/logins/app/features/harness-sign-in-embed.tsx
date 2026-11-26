/**
 * A harness's sign-in, drawn inside that harness's first-run segment (`claude-code.sign-in`, `codex.sign-in`): the
 * login of this harness that still needs signing in, or — on a machine that has none — a button that makes one and
 * starts its sign-in in the same press. Nothing leaves this panel but "signed in": the code or address a person pastes
 * stays inside {@link LoginSignIn}, and no token reaches the page that mounts it (docs/design/harness-login.md).
 */

import { Loading } from '@ferretry/app/ui';
import { CheckCircle2 } from 'lucide-react';
import { createElement, type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { LoginList } from '../../contract/index.ts';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { useLoginChanges } from '../lib/login-changes.ts';
import { readLogins } from '../lib/logins-api.ts';
import { harnessName, harnessWords } from '../../contract/harness-words.ts';
import { type HarnessKind, suggestLoginId } from '../lib/logins-view.ts';
import { ActionRow, Button, ChangeApplyPanel } from '../ui.ts';
import { LoginSignIn } from './login-sign-in.tsx';
import { SignInDemo } from './sign-in-demo.tsx';

export interface HarnessSignInEmbedProps {
  readonly client: LoginsClient;
  readonly harness: HarnessKind;
  /** Told once the harness accepted the sign-in, with the id of the login that now works. */
  readonly onSignedIn?: (loginId?: string) => void;
  /** The first read found nothing to ask: the page lifts its loading cover. */
  readonly onShown?: () => void;
  /** The first read found a usable login of this harness (its id): the page may skip itself. */
  readonly onAlreadySignedIn?: (loginId?: string) => void;
  /** A name for the login this panel makes (it keeps its id-derived name when absent). */
  readonly label?: string;
  /** Drawn above the button that makes the login, only when there is one to make (the add panel's folded name field). */
  readonly beforeMake?: ReactNode;
}

/** `refresh_due` is still a login that works: the harness refreshes it on its own. */
const USABLE: ReadonlySet<string> = new Set(['ready', 'refresh_due']);

type Row = LoginList['logins'][number];

/** A login that is switched on. A switched-off login refuses every start, so it never counts as "signed in". */
const enabled = (login: Row): boolean => login.disabled === undefined;

const rowsOf = (list: LoginList, harness: HarnessKind): readonly Row[] =>
  list.logins.filter(login => login.harness === harness);

/** A login of this harness that works NOW: switched on, and ready (or about to refresh itself). */
const usableLogin = (list: LoginList, harness: HarnessKind): Row | undefined =>
  rowsOf(list, harness).find(login => enabled(login) && USABLE.has(login.status.word));
const usable = (list: LoginList, harness: HarnessKind): boolean => usableLogin(list, harness) !== undefined;

/**
 * The login this panel works on: one of this harness, switched on, that needs a sign-in and can be signed in here. Right
 * after this panel made one, that one and no other: its sign-in starts at once, so another login must not take its place.
 */
const pending = (list: LoginList, harness: HarnessKind, made: string | null) =>
  rowsOf(list, harness).find(
    login =>
      (made === null || login.id === made) &&
      enabled(login) &&
      login.status.word === 'needs_sign_in' &&
      login.signIn.available,
  );

/** Switched on, and the machine has not yet said whether it works: not signed in, not yet known to be signed out. */
const checking = (list: LoginList, harness: HarnessKind): boolean =>
  rowsOf(list, harness).some(login => enabled(login) && login.status.word === 'checking');

export function HarnessSignInEmbed({
  client,
  harness,
  onSignedIn,
  onShown,
  onAlreadySignedIn,
  label,
  beforeMake,
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
  const alreadyAtFirst = useRef(false);
  useEffect(() => {
    if (told.current || (list === null && failure === null)) return;
    told.current = true;
    alreadyAtFirst.current = list !== null && usable(list, harness);
    if (list !== null && usable(list, harness)) onAlreadySignedIn?.(usableLogin(list, harness)?.id);
    else onShown?.();
  }, [list, failure, harness, onShown, onAlreadySignedIn]);

  // A login that was still being checked (or was signed in by another door) turns out to work: that is "signed in", once.
  const signedTold = useRef(false);
  const signedIn = useCallback(
    (loginId?: string): void => {
      if (signedTold.current) return;
      signedTold.current = true;
      onSignedIn?.(loginId);
    },
    [onSignedIn],
  );
  useEffect(() => {
    // Not on the first read: a login that already worked then is "already signed in" (above), and the page moved on.
    if (!told.current || alreadyAtFirst.current || list === null || !usable(list, harness)) return;
    signedIn(usableLogin(list, harness)?.id);
  }, [list, harness, signedIn]);

  const name = harnessName(harness);
  const demo = harnessWords(harness)?.demo;
  if (failure !== null)
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn">
        {failure}
      </p>
    );
  if (list === null) return <Loading kind="page" label="Reading the logins on this machine…" />;

  const login = pending(list, harness, made);
  if (login !== undefined)
    return (
      <LoginSignIn
        login={login}
        machineName={list.machine}
        client={client}
        autoStart={login.id === made}
        onSignedIn={() => {
          void reload();
          signedIn(login.id);
        }}
      />
    );

  if (usable(list, harness))
    return (
      // C59 O5: the end of a sign-in is a clear, visible "Signed in" (a mark and a green edge), not one more grey line.
      <div
        role="status"
        data-harness-sign-in="done"
        className="flex items-start gap-3 rounded-panel border border-ok/40 bg-ok-bg p-panel text-ui leading-base text-fg"
      >
        <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        <div className="min-w-0">
          <p className="m-0 font-semibold">Signed in</p>
          <p className="m-0 text-cell text-muted">
            {name} is signed in on {list.machine}.
          </p>
        </div>
      </div>
    );

  // The machine has not finished checking: that is not "signed in", and not "signed out" either. Say so, and offer to look again.
  if (checking(list, harness))
    return (
      <section className="flex flex-col gap-3" data-harness-sign-in="checking">
        <p role="status" className="m-0 text-cell leading-base text-muted">
          Checking the {name} sign-in on {list.machine}…
        </p>
        <ActionRow secondary={<Button onClick={() => void reload()}>Check again</Button>} />
      </section>
    );

  // Rows that exist but cannot be signed in from here (switched off, or sign-in not available): said, never a dead end —
  // the Add action below stays.
  const blocked = rowsOf(list, harness).flatMap(item =>
    !enabled(item)
      ? [`A ${name} sign-in on ${list.machine} is switched off.`]
      : item.status.word === 'needs_sign_in' && !item.signIn.available
        ? [item.signIn.reason]
        : [],
  );

  const make = async (): Promise<void> => {
    const id = suggestLoginId(harness, undefined, new Set(list.logins.map(item => item.id)));
    const result = await changes.apply({ kind: 'login.add', id, harness, ...(label === undefined ? {} : { label }) });
    if (result.kind !== 'applied') return;
    setMade(id);
    await reload();
  };

  // O12 S1: the idle page shows the how-to picture too, in the box the sign-in card gives it (the same layout, the same
  // picture): Claude's and Codex's idle pages are this one piece, and the heading above never moves when the card replaces it.
  return (
    <section className="fy-sd-host" data-harness-sign-in={harness}>
      <div className="fy-sd-layout">
        <div className="fy-sd-steps flex flex-col gap-3">
          {blocked.map(sentence => (
            <p key={sentence} className="m-0 text-cell leading-base text-muted" data-harness-sign-in-blocked="">
              {sentence}
            </p>
          ))}
          <p className="m-0 text-cell leading-base text-muted">
            {blocked.length === 0
              ? `There is no ${name} sign-in on ${list.machine} yet.`
              : `None of them can be signed in here.`}{' '}
            This makes one and starts signing it in.
          </p>
          {beforeMake}
          <ChangeApplyPanel
            machineName={list.machine}
            authority={changes.authority}
            busy={changes.busy}
            busyLabel="Adding…"
            refusal={changes.refusal}
            submitLabel={`Sign in to ${name}`}
            onSubmit={() => void make()}
          />
        </div>
        {demo === undefined ? null : <SignInDemo kind={demo} />}
      </div>
    </section>
  );
}

/** The slot panel: the page that mounts it hands `{ onSignedIn() }`; the props are untyped at the shell, so it checks. */
export function harnessSignIn(
  client: LoginsClient,
  harness: HarnessKind,
  props: Readonly<Record<string, unknown>>,
): ReactElement {
  const callback = (name: string): ((loginId?: string) => void) | undefined => {
    const value = props[name];
    return typeof value === 'function'
      ? (loginId?: string) => (value as (loginId?: string) => void)(loginId)
      : undefined;
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
