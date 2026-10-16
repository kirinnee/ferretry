/**
 * THE CONSOLE: the agent's own Claude / Codex pane, live, and typeable from wherever the reader is.
 *
 * WHAT IS LIVE. The pane is captured straight off tmux (`/snapshot?live=true`) while the Console is on
 * screen, and again the moment a write lands, so a key shows its effect without waiting a poll.
 *
 * WHAT IS TYPEABLE. Keys go to `POST /v1/sessions/:id/console/input`, which the daemon governs exactly
 * as it governs a session terminal (`docs/grants.md`): a paired device needs `terminal` and its unlock,
 * and a refusal is shown in the grant's own words. Writes are sent one after another, never
 * concurrently, so the pane receives keys in the order they were pressed.
 *
 * WHY A TEXT FIELD AND NOT AN EMULATOR. The screen is a capture, not a stream, so there is no cursor
 * for an emulator to own; a plain field is what a phone keyboard, autocorrect and an IME can type into.
 * The keys a field would keep for itself are translated at keydown (`console-keys.ts`), and the phone
 * key bar writes through the same port a terminal tab's does.
 */

import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalInputPort } from '../../components/session-terminal-deck.tsx';
import { loadTerminalFont } from '../../components/terminal-font-loader.ts';
import { type PaneSnapshotReader, TerminalSnapshotView } from '../../components/terminal-snapshot.tsx';
import { readPaneSnapshot } from '../../components/terminal-snapshot-model.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { grantRefusalNotice } from '../../lib/grants.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { terminalFontFamily } from '../../lib/terminal-font.ts';
import { typeIntoSessionConsole } from '../../lib/web-terminals.ts';
import { consoleKeyInput } from './console-keys.ts';

/** Sends one write to the session's own pane. Injected so tests and the harness never reach a daemon. */
export type ConsoleTyper = (daemon: DaemonConnection, scope: DaemonSessionScope, data: string) => Promise<unknown>;

export interface ConsoleSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly readSnapshot?: PaneSnapshotReader;
  readonly typeInto?: ConsoleTyper;
  /** Rewrites typed text before it is sent: the phone key bar's sticky ctrl. */
  readonly interceptInput?: (data: string) => string;
  /** Hands the host a way to type into, and focus, the Console — the phone key bar. */
  readonly onInputPort?: (port: TerminalInputPort | null) => void;
  /** The agent's first name; without one the Console speaks of "the agent". */
  readonly agentName?: string;
}

/** A refusal in the grant's own words when it is one; the daemon's message otherwise. */
const refusalText = (error: unknown): string => {
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`;
  return error instanceof Error ? error.message : String(error);
};

const passInput = (data: string): string => data;

export function ConsoleSurface({
  connection,
  scope,
  readSnapshot,
  typeInto,
  interceptInput = passInput,
  onInputPort,
  agentName = '',
}: ConsoleSurfaceProps) {
  const whom = agentName === '' ? 'the agent' : agentName;
  const whose = `${whom}’s`;
  const fetcher = useDaemonFetch();
  const reader = useMemo<PaneSnapshotReader>(
    () => readSnapshot ?? ((daemon, at) => readPaneSnapshot(daemon, at, undefined, fetcher, true)),
    [fetcher, readSnapshot],
  );
  const typer = useMemo<ConsoleTyper>(
    () => typeInto ?? ((daemon, at, data) => typeIntoSessionConsole(daemon, at, data, fetcher)),
    [fetcher, typeInto],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [font, setFont] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The pane is drawn in the terminal's face once it is loaded, so a host with no monospace font of
  // its own still shows the agent's columns lined up.
  useEffect(() => {
    let live = true;
    void loadTerminalFont().then(() => {
      if (live) setFont(terminalFontFamily(getComputedStyle(document.documentElement).getPropertyValue('--font-mono')));
    });
    return () => {
      live = false;
    };
  }, []);

  const send = useCallback(
    (data: string): void => {
      if (data === '') return;
      queue.current = queue.current.then(async () => {
        try {
          await typer(connection, scope, data);
          setRefusal(null);
        } catch (error) {
          setRefusal(refusalText(error));
        }
        setRefreshKey(key => key + 1);
      });
    },
    [connection, scope, typer],
  );

  useEffect(() => {
    if (onInputPort === undefined) return;
    onInputPort({ write: send, focus: () => inputRef.current?.focus() });
    return () => onInputPort(null);
  }, [onInputPort, send]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const bytes = consoleKeyInput(event);
    if (bytes === null) return;
    event.preventDefault();
    send(bytes);
  };

  // Printable text arrives here — typed, pasted, autocorrected or composed — and the field is emptied
  // straight away: it is a keyboard, not a draft.
  const onInput = (event: FormEvent<HTMLInputElement>): void => {
    const field = event.currentTarget;
    if ((event.nativeEvent as InputEvent).isComposing === true) return;
    const text = field.value;
    field.value = '';
    send(interceptInput(text));
  };

  return (
    <section aria-label="Console" className="flex min-h-0 flex-1 flex-col gap-2 p-2" data-workspace-console="">
      <p className="m-0 text-ui text-muted">
        {agentName === '' ? 'The agent’s' : whose} own CLI pane, live. What you type below goes straight into it, key by
        key — Chat is still the place to send {whom} a turn.
      </p>
      <TerminalSnapshotView
        daemon={connection}
        live
        readSnapshot={reader}
        refreshKey={refreshKey}
        scope={scope}
        {...(font === undefined ? {} : { fontFamily: font })}
      />
      <label className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-code-bg px-3 text-code-fg focus-within:border-accent">
        <span aria-hidden="true" className="mono text-muted">
          ›
        </span>
        <input
          aria-label={`Type into ${whose} Console`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="mono min-h-[44px] min-w-0 flex-1 border-0 bg-transparent text-ui text-code-fg outline-none focus-visible:outline-none"
          data-console-input=""
          enterKeyHint="send"
          onCompositionEnd={event => {
            const field = event.currentTarget;
            const text = field.value;
            field.value = '';
            send(interceptInput(text));
          }}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={`Type here — keys go to ${whose} pane as you press them`}
          ref={inputRef}
          spellCheck={false}
          type="text"
        />
      </label>
      {refusal === null ? null : (
        <p className="m-0 text-ui text-err" role="alert">
          {refusal}
        </p>
      )}
    </section>
  );
}
