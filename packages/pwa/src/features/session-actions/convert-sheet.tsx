/**
 * "Move to Codex… / Move to Claude…": moves a ferret onto an account of the OTHER harness by converting
 * its conversation into that harness's own format.
 *
 * The sheet reads what the conversion would carry BEFORE it offers the button, says it in plain words,
 * and shows a refusal in place of the button. The move itself can take about two minutes — the daemon
 * runs the target CLI once to prove it opens the converted file — so it holds the sheet open with one
 * clear sentence about what it is doing. Nothing changes on any failure, and the sheet says so.
 *
 * It looks like the Move-to-login sheet because it IS that sheet's shell: the same BottomSheet, header,
 * panel and buttons. A move paused for in-flight work gets the Restart panel's own wording and its one
 * deliberate way past, "Move anyway".
 */

import type { ConversionPreview, SessionView } from '@ferretry/protocol';
import { AlertTriangle, ArrowLeftRight, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { accountLabel } from '../../components/daemon-picker-model.ts';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { useDaemonClient, useDaemonFetch } from '../../lib/store.tsx';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { moveToOtherHarness, readConversionPreview } from './conversion-api.ts';
import { HARNESS_SHORT, otherHarness } from '../fleet/credentials/credentials-model.ts';
import { type ConversionFailure, conversionFailure, conversionSentences } from './conversion-model.ts';
import { refusedCause } from './session-operations.ts';

export type ReadConversionPreview = (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  agent: string,
) => Promise<ConversionPreview>;

export type MoveToOtherHarness = (
  connection: DaemonConnection,
  view: SessionView,
  agent: string,
  requestId: string,
  forceInflight: boolean,
) => Promise<SessionView>;

export interface ConvertSheetProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly view: SessionView;
  /** The accounts of the other harness this ferret could move onto, already narrowed by the caller. */
  readonly accounts: readonly PickerAccount[];
  readonly open: boolean;
  readonly onClose: () => void;
  /** The authoritative view after the move, and one sentence for the toast. */
  readonly onMoved: (view: SessionView, notice: string) => void;
  /** Tests hand these in; the app reads through the carrier-routed fetch and client. */
  readonly readPreview?: ReadConversionPreview;
  readonly move?: MoveToOtherHarness;
}

type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: Extract<ConversionPreview, { kind: 'ready' }> }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly message: string };

type MovePhase = 'idle' | 'moving' | 'paused';

const IDLE: PreviewState = { status: 'idle' };

export function ConvertSheet({
  connection,
  scope,
  view,
  accounts,
  open,
  onClose,
  onMoved,
  readPreview,
  move,
}: ConvertSheetProps) {
  const routedClient = useDaemonClient();
  const fetcher = useDaemonFetch();
  const read: ReadConversionPreview =
    readPreview ?? ((target, sessionScope, agent) => readConversionPreview(target, sessionScope, fetcher, agent));
  const run: MoveToOtherHarness =
    move ??
    (async (target, sessionView, agent, requestId, force) =>
      await moveToOtherHarness(await routedClient(target), sessionView, agent, requestId, force));
  const headingId = useId();
  const pickId = useId();
  const source = view.config.harness;
  const target = otherHarness(source);
  const targetName = HARNESS_SHORT[target];
  const sourceName = HARNESS_SHORT[source];
  const only = accounts.length === 1 ? (accounts[0]?.wrapper ?? null) : null;
  const [chosen, setChosen] = useState<string | null>(only);
  const [preview, setPreview] = useState<PreviewState>(IDLE);
  const [phase, setPhase] = useState<MovePhase>('idle');
  const [failure, setFailure] = useState<ConversionFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const submitLock = useRef(false);
  const requestIdentity = useRef<{ key: string; id: string } | null>(null);
  const identity = JSON.stringify([connection.daemonId, daemonSessionKey(scope), view.config.id]);
  const liveIdentity = useRef(identity);
  liveIdentity.current = identity;
  const latest = useRef({ read, connection, scope });
  latest.current = { read, connection, scope };

  // Everything local belongs to this exact daemon and session, and to one opening of the sheet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger
  useLayoutEffect(() => {
    if (!open) return;
    setChosen(only);
    setPreview(IDLE);
    setPhase('idle');
    setFailure(null);
    submitLock.current = false;
    requestIdentity.current = null;
  }, [open, identity, only]);

  // The preview is a read, so it follows the choice; a late answer for an earlier choice is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is the deliberate re-read trigger
  useEffect(() => {
    if (!open || chosen === null) return;
    let current = true;
    setPreview({ status: 'loading' });
    const { read: readNow, connection: daemon, scope: sessionScope } = latest.current;
    readNow(daemon, sessionScope, chosen)
      .then(answer => {
        if (!current) return;
        setPreview(
          answer.kind === 'ready' ? { status: 'ready', preview: answer } : { status: 'refused', reason: answer.reason },
        );
      })
      .catch((reason: unknown) => {
        if (current)
          setPreview({ status: 'failed', message: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => {
      current = false;
    };
  }, [open, chosen, identity, connection.baseUrl, connection.deviceId, retry]);

  const choose = (wrapper: string): void => {
    setChosen(wrapper);
    setPreview(IDLE);
    setFailure(null);
    setPhase('idle');
  };

  const startMove = useCallback(
    async (force: boolean): Promise<void> => {
      if (submitLock.current || chosen === null || preview.status !== 'ready') return;
      const submitted = liveIdentity.current;
      // One id per logical move; forcing past in-flight work changes the body, so it is a new id.
      const key = JSON.stringify([submitted, chosen, force]);
      const current = requestIdentity.current?.key === key ? requestIdentity.current : { key, id: crypto.randomUUID() };
      requestIdentity.current = current;
      submitLock.current = true;
      setFailure(null);
      setPhase('moving');
      try {
        const moved = await run(connection, view, chosen, current.id, force);
        if (liveIdentity.current !== submitted) return;
        const picked = accounts.find(account => account.wrapper === chosen);
        onMoved(moved, `Moved to ${targetName} (${picked === undefined ? chosen : accountLabel(picked).name}).`);
        onClose();
      } catch (reason) {
        if (liveIdentity.current !== submitted) return;
        const next = conversionFailure(reason);
        setFailure(next);
        setPhase(next.kind === 'inflight' ? 'paused' : 'idle');
      } finally {
        if (liveIdentity.current === submitted) submitLock.current = false;
      }
    },
    [accounts, chosen, connection, onClose, onMoved, preview.status, run, targetName, view],
  );

  const scopeMismatch = connection.daemonId !== scope.daemonId || scope.sessionId !== view.config.id;
  const moving = phase === 'moving';
  const ready = preview.status === 'ready' && !scopeMismatch;

  return (
    <BottomSheet
      id={`convert-${view.config.id}`}
      open={open}
      onClose={moving ? () => undefined : onClose}
      labelledBy={headingId}
      closeLabel={`Close move to ${targetName}`}
      panelClassName="kt-details bg-surface"
      maxHeight="min(94dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y" data-daemon-id={connection.daemonId}>
        <div className="flex items-center gap-sm">
          <ArrowLeftRight aria-hidden="true" className="text-accent" size={16} />
          <h1 id={headingId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Move to {targetName}
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Continue this conversation on a {targetName} account. It keeps its name, folder and history.
        </p>
      </div>

      {moving ? (
        <div
          className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-panel pb-6 text-center"
          data-convert-moving=""
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={28} />
          <p className="m-0 text-title font-semibold text-fg">Checking that {targetName} can open the conversation…</p>
          <p className="m-0 max-w-xl text-ui leading-base text-muted">
            Keep this sheet open. This can take a couple of minutes for a long conversation.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
          <div className="relative mx-auto grid w-full max-w-2xl gap-4 py-4">
            {accounts.length > 1 ? (
              <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" data-convert-accounts="">
                <legend className="mb-1 p-0 text-ui font-semibold text-fg">Move to which {targetName} account?</legend>
                {accounts.map(account => {
                  const label = accountLabel(account);
                  const checked = chosen === account.wrapper;
                  return (
                    <label
                      className={`flex min-h-control min-w-0 cursor-pointer items-center gap-sm rounded-control border px-control-x py-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                        checked ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg'
                      }`}
                      key={account.id}
                    >
                      <input
                        checked={checked}
                        className="sr-only"
                        name={pickId}
                        onChange={() => choose(account.wrapper)}
                        type="radio"
                        value={account.wrapper}
                      />
                      <span className="min-w-0 break-words text-ui font-semibold">{label.name}</span>
                      {label.id === null ? null : <span className="mono text-meta text-muted">{label.id}</span>}
                    </label>
                  );
                })}
              </fieldset>
            ) : null}

            {scopeMismatch ? (
              <p className="m-0 text-ui leading-base text-err" role="alert">
                This session does not belong to the selected machine. Return to the fleet and reopen it first.
              </p>
            ) : preview.status === 'idle' ? (
              <p className="m-0 text-ui leading-base text-muted" data-convert-choose="">
                Choose an account to see what will move.
              </p>
            ) : preview.status === 'loading' ? (
              <p
                className="m-0 flex items-center gap-sm text-ui leading-base text-muted"
                data-convert-loading=""
                role="status"
              >
                <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={16} />
                Reading the conversation…
              </p>
            ) : preview.status === 'refused' ? (
              <section
                aria-labelledby={`${headingId}-refused`}
                className="rounded-control border border-err bg-surface-2 p-4"
                data-convert-refused=""
                role="alert"
              >
                <h2 className="m-0 text-title font-semibold text-fg" id={`${headingId}-refused`}>
                  This conversation can’t move to {targetName}
                </h2>
                <p className="mt-2 break-words text-ui leading-base text-err">{preview.reason}</p>
                <p className="mt-2 text-ui leading-base text-muted">Nothing was changed.</p>
              </section>
            ) : preview.status === 'failed' ? (
              <section
                className="rounded-control border border-err bg-surface-2 p-4"
                data-convert-failed=""
                role="alert"
              >
                <p className="m-0 break-words text-ui leading-base text-err">{preview.message}</p>
                <Button className="mt-3 min-h-[44px]" onClick={() => setRetry(count => count + 1)} type="button">
                  Try again
                </Button>
              </section>
            ) : (
              <PreviewBody preview={preview.preview} />
            )}

            {failure?.kind === 'message' ? (
              <section
                className="rounded-control border border-err bg-surface-2 p-4"
                data-convert-failure=""
                role="alert"
              >
                <p className="m-0 break-words text-ui leading-base text-err">{failure.text}</p>
                <p className="mt-2 text-ui leading-base text-muted">Nothing was changed.</p>
              </section>
            ) : null}

            {failure?.kind === 'inflight' ? (
              <section
                aria-label="Move paused"
                className="rounded-control border border-warn-border bg-surface-2 p-4"
                data-convert-paused=""
                role="alert"
              >
                <div className="flex items-start gap-sm text-warn">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
                  <p className="m-0 text-ui font-semibold leading-base text-fg">
                    Move paused — {refusedCause(failure.refusal)}. Nothing was moved.
                  </p>
                </div>
                <ul className="mt-2 grid gap-1 pl-5 text-ui leading-base text-muted" style={{ listStyle: 'disc' }}>
                  {failure.refusal.items
                    .filter(item => item.blocks)
                    .map((item, index) => (
                      // The daemon lists items in a fixed order and nothing reorders them.
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable, append-free list
                      <li key={index}>
                        {item.title}
                        {item.detail === undefined ? null : <span className="mono"> {item.detail}</span>}
                      </li>
                    ))}
                </ul>
                <p className="mt-2 text-ui leading-base text-muted">
                  Moving anyway stops what is listed above. Anything it was in the middle of is lost.
                </p>
              </section>
            ) : null}

            <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
              <Button className="min-h-[44px]" data-convert-cancel="" onClick={onClose} type="button">
                Cancel
              </Button>
              {phase === 'paused' ? (
                <Button
                  className="min-h-[44px]"
                  data-convert-anyway=""
                  onClick={() => void startMove(true)}
                  type="button"
                  variant="danger"
                >
                  Move anyway
                </Button>
              ) : ready ? (
                <Button
                  className="min-h-[44px]"
                  data-convert-confirm=""
                  onClick={() => void startMove(false)}
                  type="button"
                  variant="primary"
                >
                  Move to {targetName}
                </Button>
              ) : null}
            </div>
            <p className="sr-only">
              Moving from {sourceName} to {targetName}.
            </p>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function PreviewBody({ preview }: { readonly preview: Extract<ConversionPreview, { kind: 'ready' }> }) {
  const sentences = conversionSentences(preview.summary, preview.targetModel);
  return (
    <section className="grid gap-2" data-convert-preview="">
      <p className="m-0 text-title font-semibold text-fg">{sentences.headline}</p>
      {sentences.cutNewest === null ? null : (
        <p className="m-0 text-ui leading-base text-warn">{sentences.cutNewest}</p>
      )}
      {sentences.carried.map(sentence => (
        <p className="m-0 text-ui leading-base text-fg" key={sentence}>
          {sentence}
        </p>
      ))}
      {sentences.notCarried === null ? null : (
        <p className="m-0 text-ui leading-base text-muted">{sentences.notCarried}</p>
      )}
      <p className="m-0 rounded-control border border-border-soft bg-surface-2 p-3 text-ui leading-base text-muted">
        {sentences.note}
      </p>
      <p className="m-0 text-meta leading-base text-muted">{sentences.versions}</p>
    </section>
  );
}
