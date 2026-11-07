/**
 * "Move to Codex… / Move to Claude…": moves a ferret onto an account of the OTHER CLI by converting its
 * conversation into that CLI's own format.
 *
 * The page reads what the conversion would carry BEFORE it offers the button, says it in plain words, and shows a
 * refusal in place of the button. The move itself can take about two minutes — the daemon runs the target CLI once to
 * prove it opens the converted file — so it holds the page with one clear sentence about what it is doing. Nothing
 * changes on any failure, and the page says so. A move paused for in-flight work gets the Restart panel's own wording
 * and its one deliberate way past, "Move anyway".
 *
 * The accounts offered are the slot `ferrets.move-account` handed the OTHER harness: Runtimes draws the ones that can
 * run it. This page decides nothing about which those are.
 */

import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChosenFerretAccount, ConversionPreview, FerretSummary } from '../../../contract/index.ts';
import { Button } from '../../ui.ts';
import { AccountSlot, type RenderAccountSlot } from './account-slot.tsx';
import { moveCallFailure } from './call-failure.ts';
import {
  type ConversionFailure,
  conversionFailure,
  conversionSentences,
  HARNESS_SHORT,
  otherHarness,
  refusedCause,
} from './conversion-model.ts';

type ReadConversionPreview = (agent: string) => Promise<ConversionPreview>;
type MoveToOtherHarness = (agent: string, requestId: string, forceInflight: boolean) => Promise<FerretSummary>;

export interface ConvertHarnessProps {
  readonly summary: FerretSummary;
  readonly slot: RenderAccountSlot;
  readonly readPreview: ReadConversionPreview;
  readonly move: MoveToOtherHarness;
  readonly onCancel: () => void;
  /** The authoritative summary after the move, and one sentence for the notice. */
  readonly onMoved: (summary: FerretSummary, notice: string) => void;
}

type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: Extract<ConversionPreview, { kind: 'ready' }> }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly message: string };

type MovePhase = 'idle' | 'moving' | 'paused';

const IDLE: PreviewState = { status: 'idle' };

export function ConvertHarness({ summary, slot, readPreview, move, onCancel, onMoved }: ConvertHarnessProps) {
  const headingId = useId().replace(/:/gu, '');
  const fieldId = useId().replace(/:/gu, '');
  const source = summary.harness;
  const target = otherHarness(source);
  const targetName = HARNESS_SHORT[target];
  const sourceName = HARNESS_SHORT[source];
  const [agent, setAgent] = useState('');
  const [chosen, setChosen] = useState<ChosenFerretAccount | null>(null);
  // Without a picker (no Runtimes on this daemon) the wrapper is typed, and read only when the reader asks.
  const [typedCheck, setTypedCheck] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>(IDLE);
  const [phase, setPhase] = useState<MovePhase>('idle');
  const [failure, setFailure] = useState<ConversionFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const submitLock = useRef(false);
  const requestIdentity = useRef<{ key: string; id: string } | null>(null);
  const liveIdentity = useRef(summary.id);
  liveIdentity.current = summary.id;
  const latest = useRef({ readPreview });
  latest.current = { readPreview };

  // The account the preview follows: an offered account whose wrapper the field still names, else a typed one the
  // reader asked to check.
  const offered = chosen !== null && chosen.kind === target && chosen.wrapper === agent.trim() ? chosen : null;
  const previewAgent = offered?.wrapper ?? typedCheck;

  // Everything local belongs to this exact ferret.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ferret reset trigger
  useLayoutEffect(() => {
    setAgent('');
    setChosen(null);
    setTypedCheck(null);
    setPreview(IDLE);
    setPhase('idle');
    setFailure(null);
    submitLock.current = false;
    requestIdentity.current = null;
  }, [summary.id]);

  // The preview is a read, so it follows the choice; a late answer for an earlier choice is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is the deliberate re-read trigger
  useEffect(() => {
    if (previewAgent === null) {
      setPreview(IDLE);
      return;
    }
    let current = true;
    setPreview({ status: 'loading' });
    latest.current
      .readPreview(previewAgent)
      .then(answer => {
        if (!current) return;
        setPreview(
          answer.kind === 'ready' ? { status: 'ready', preview: answer } : { status: 'refused', reason: answer.reason },
        );
      })
      .catch((reason: unknown) => {
        if (current) setPreview({ status: 'failed', message: moveCallFailure(reason).message });
      });
    return () => {
      current = false;
    };
  }, [previewAgent, retry]);

  const editAgent = (next: string): void => {
    setAgent(next);
    setTypedCheck(null);
    setPreview(IDLE);
    setFailure(null);
    setPhase('idle');
  };

  const startMove = useCallback(
    async (force: boolean): Promise<void> => {
      if (submitLock.current || previewAgent === null || preview.status !== 'ready') return;
      const submitted = summary.id;
      // One id per logical move; forcing past in-flight work changes the body, so it is a new id.
      const key = JSON.stringify([submitted, previewAgent, force]);
      const current = requestIdentity.current?.key === key ? requestIdentity.current : { key, id: crypto.randomUUID() };
      requestIdentity.current = current;
      submitLock.current = true;
      setFailure(null);
      setPhase('moving');
      try {
        const moved = await move(previewAgent, current.id, force);
        if (liveIdentity.current !== submitted) return;
        onMoved(moved, `Moved to ${targetName} (${offered?.displayName ?? previewAgent}).`);
      } catch (reason) {
        if (liveIdentity.current !== submitted) return;
        const next = conversionFailure(moveCallFailure(reason));
        setFailure(next);
        setPhase(next.kind === 'inflight' ? 'paused' : 'idle');
      } finally {
        if (liveIdentity.current === submitted) submitLock.current = false;
      }
    },
    [move, offered, onMoved, preview.status, previewAgent, summary.id, targetName],
  );

  const moving = phase === 'moving';
  const ready = preview.status === 'ready';

  if (moving) {
    return (
      <div
        className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-panel pb-6 text-center"
        data-convert-moving=""
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={28} />
        <p className="m-0 text-title font-semibold text-fg">Checking that {targetName} can open the conversation…</p>
        <p className="m-0 max-w-xl text-ui leading-base text-muted">
          Keep this page open. This can take a couple of minutes for a long conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
      <div className="relative mx-auto grid w-full max-w-2xl gap-4 py-4">
        <p className="m-0 text-ui leading-base text-muted">
          Continue this conversation on a {targetName} account. It keeps its name, folder and history.
        </p>
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" data-convert-accounts="">
          <legend className="mb-1 p-0 text-ui font-semibold text-fg" id={`${headingId}-account`}>
            Move to which {targetName} account?
          </legend>
          <AccountSlot
            fallbackLabel={`${targetName} account`}
            field={{
              harness: target,
              value: agent,
              onValueChange: editAgent,
              onChosen: setChosen,
              fallbackId: fieldId,
              labelId: `${headingId}-account`,
              fallbackPlaceholder: target === 'codex' ? 'codex-default' : 'claude-default',
              noAccounts: (
                <p className="m-0 text-ui text-muted" data-convert-no-accounts="">
                  No {targetName} account on this daemon can run a ferret, so there is nothing to move to.
                </p>
              ),
            }}
            render={slot}
          />
          {offered === null && agent.trim() !== '' ? (
            <Button
              className="min-h-[44px] w-full justify-center sm:w-auto"
              data-convert-check=""
              onClick={() => setTypedCheck(agent.trim())}
              type="button"
            >
              See what will move
            </Button>
          ) : null}
        </fieldset>

        {preview.status === 'idle' ? (
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
          <section className="rounded-control border border-err bg-surface-2 p-4" data-convert-failed="" role="alert">
            <p className="m-0 break-words text-ui leading-base text-err">{preview.message}</p>
            <Button className="mt-3 min-h-[44px]" onClick={() => setRetry(count => count + 1)} type="button">
              Try again
            </Button>
          </section>
        ) : (
          <PreviewBody preview={preview.preview} />
        )}

        {failure?.kind === 'message' ? (
          <section className="rounded-control border border-err bg-surface-2 p-4" data-convert-failure="" role="alert">
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
          <Button className="min-h-[44px]" data-convert-cancel="" onClick={onCancel} type="button">
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
