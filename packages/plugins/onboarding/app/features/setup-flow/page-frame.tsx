/**
 * ONE PAGE OF THE FLOW: the plugin's page, mounted under a loading cover, inside the shared step frame.
 *
 * The page is drawn by the plugin (`panel('onboarding.step')` for this step's subject) and handed a `StepHost` as its
 * `step` prop. The shell's rules, so no page can break the flow (contract/step-host.ts):
 *   1. the page is mounted at once but hidden under a cover ("Checking …") until it calls `ready()` or `skip()`; the cover
 *      and the page never show together, so nothing pops in;
 *   2. after STEP_SILENCE_MS of silence the cover adds "Skip this step": a page that never answers never blocks;
 *   3. `busy(label)` locks the whole footer (Next, Back, Later) and says what is happening; `done()` is recorded once;
 *   4. (r11 O1) the cover draws NOTHING for its first LOADING_DELAY_MS (300 ms): it keeps the page's height and then shows the
 *      loader, so a page that answers inside that beat never flashes one; once the loader is up it stays for its minimum
 *      (fade + min, r11-1b G6), so an answer a few frames later does not blink it, and the page is drawn after it goes;
 *   5. (r11 O1) a page that registered `commit` is SAVED by Next (contract rule 8): the footer is busy 'Saving…', and a save that
 *      rejects (or throws while it is being prepared) keeps the page, shows the error in the footer line, where it stays on screen
 *      with Next, and leaves Next ready to run it again;
 *   6. a step that does not declare `stepHost` is a LEGACY page (it never calls `ready()`): it is drawn with no cover, Next
 *      enabled and done recorded on Next, so a page not yet written against StepHost is never trapped behind a cover.
 * Next, Back and Later are the shell's and live in the frame's footer row (Back · Later · Next), so every page has the same footer.
 */
import { PanelSlot, StepPageFrame, useSlotPanels } from '@ferretry/app';
import { Badge, Button, LOADING_DELAY_MS, Loading, useHeldLoading, useMotionAllowed } from '@ferretry/app/ui';
import type { StepHost } from '@ferretry/kernel/contract';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ONBOARDING_STEP_SLOT } from '../../../contract/index.ts';
import { STEP_SILENCE_MS } from '../../../contract/step-host.ts';
import type { FlowStep } from '../../lib/index.ts';
import type { ProgressRead } from './flow-model.ts';
import './flow.css';

export interface FlowPageProps {
  readonly step: FlowStep;
  /** The machine whose panel draws the page. */
  readonly daemon: string;
  readonly progress: ProgressRead | undefined;
  readonly direction: 'forward' | 'back';
  readonly canBack: boolean;
  readonly segment: () => StepHost['segment'];
  readonly remember: StepHost['remember'];
  readonly onDone: () => void;
  readonly onSkip: (why: 'not-needed' | 'already-set') => void;
  readonly onNotNeeded: () => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onLater: () => void;
  /** The words on the footer's Later button when the page has better ones ("Skip for now" on project setup); default "Later". */
  readonly laterLabel?: string;
  /** Called once when this visit has truly drawn its own content (the page said `ready()` or put up a `busy` label). */
  readonly onShown?: () => void;
  /** The answers the machine did not take, and the way to try again. */
  readonly unsaved?: { readonly count: number; readonly retry: () => void } | undefined;
  /** Test seam: how long a page may stay silent. */
  readonly silenceMs?: number;
  /** Where the dev-only "this page never declared `stepHost`" report goes (default: `console.warn` outside production). */
  readonly report?: (message: string) => void;
  /** What draws the page. The default is the plugin's own panel in the `onboarding.step` slot; a scene or test hands its own. */
  readonly render?: (host: StepHost) => ReactNode;
}

/** The cover is blank this long (owner item 4: a loader needs a 300 ms threshold); the shared delay may only be longer. */
const COVER_DELAY_MS = Math.max(LOADING_DELAY_MS, 300);

/** The default report: a console warning, development builds only. */
const devReport = (message: string): void => {
  if (import.meta.env.DEV) console.warn(message);
};

/** The plugin's own page for a step: the panel it placed in the `onboarding.step` slot, drawn for this step's subject. */
function PluginPage({
  step,
  daemon,
  host,
  onMissing,
}: {
  readonly step: FlowStep;
  readonly daemon: string;
  readonly host: StepHost;
  readonly onMissing: () => void;
}): ReactNode {
  // A plugin that is off (or has no page for this step) places no panel: nothing to wait for.
  const offered = useSlotPanels(ONBOARDING_STEP_SLOT).some(panel => panel.plugin === step.plugin);
  useEffect(() => {
    if (!offered) onMissing();
  }, [offered, onMissing]);
  return <PanelSlot daemon={daemon} slot={ONBOARDING_STEP_SLOT} subject={step.key} props={{ step: host }} />;
}

/** "Only on <machine>": a step some paired machines do not carry says which ones do. */
function OnlyOnChip({ names }: { readonly names: readonly string[] }): ReactNode {
  if (names.length === 0) return null;
  return (
    <Badge tone="accent" className="fy-sf-chip" data-only-on="">
      Only on {names.join(', ')}
    </Badge>
  );
}

export function FlowPage(props: FlowPageProps): ReactNode {
  const { step, daemon, progress, direction, canBack, unsaved } = props;
  const moving = useMotionAllowed();
  // A legacy page (no `stepHost`) never says it is ready, so it starts ready and has no cover.
  const [ready, setReady] = useState(!step.stepHost);
  const [busy, setBusy] = useState<string | null>(null);
  // The page said its own button is the way on (`holdNext`): the footer draws no Next until it says otherwise.
  const [held, setHeld] = useState(false);
  const [silent, setSilent] = useState(false);
  // The loader is drawn only once the cover has waited COVER_DELAY_MS; before that the cover only holds the page's room.
  const [loaderDue, setLoaderDue] = useState(false);
  // Once the loader is up it stays for its minimum (`delay: 0`: the cover's own 300 ms already waited), so an answer a few
  // frames after it came up does not blink it (r11-1b G6). The page stays hidden, and Next off, until the cover goes.
  const loaderHeld = useHeldLoading(loaderDue && !ready, { delay: 0 });
  const covered = !ready || loaderHeld;
  const [saveError, setSaveError] = useState<string | null>(null);
  // What Next must save (contract rule 8), the act in flight, and whether the page is still on screen.
  const commit = useRef<(() => Promise<void>) | null>(null);
  const saving = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The host is made once per page: its calls reach the latest callbacks through this ref.
  const latest = useRef(props);
  latest.current = props;
  // Whether this visit has drawn its own content (it said `ready()` or put up a `busy` label): contract rule 7 honours
  // `notNeeded()` only from a page that is still passing over, never from one the person is looking at.
  const shown = useRef(false);
  const host = useMemo<StepHost>(() => {
    // A legacy (flagless) page is not written against the host. One that calls ready/busy/done/skip anyway forgot its flag:
    // it is reported (never blocked) so the manifest entry gets `stepHost: true`.
    const reported = new Set<string>();
    const flagless = (call: string): void => {
      if (step.stepHost || reported.has(call)) return;
      reported.add(call);
      (latest.current.report ?? devReport)(
        `onboarding: ${step.key} called step.${call}() but its manifest entry does not declare stepHost: true`,
      );
    };
    return {
      phase: step.phase,
      appliesTo: step.appliesTo,
      get segment() {
        return latest.current.segment();
      },
      remember: patch => latest.current.remember(patch),
      ready: () => {
        flagless('ready');
        if (!shown.current) latest.current.onShown?.();
        shown.current = true;
        setReady(true);
      },
      skip: why => {
        flagless('skip');
        latest.current.onSkip(why);
      },
      notNeeded: () => {
        flagless('notNeeded');
        if (shown.current) {
          // Rule 7: a page that was shown can never become not needed in this visit; only Next moves on and records.
          (latest.current.report ?? devReport)(
            `onboarding: ${step.key} called step.notNeeded() after it was shown; ignored (only a page passing over may call it, on mount)`,
          );
          return;
        }
        latest.current.onNotNeeded();
      },
      done: () => {
        flagless('done');
        latest.current.onDone();
      },
      commit: save => {
        flagless('commit');
        commit.current = save;
        // A page registers its save again when its pick changes: a refusal of the old pick must not linger over the new one.
        setSaveError(null);
      },
      holdNext: on => {
        flagless('holdNext');
        setHeld(on);
      },
      busy: label => {
        flagless('busy');
        if (label !== null) {
          if (!shown.current) latest.current.onShown?.();
          shown.current = true;
        }
        setBusy(label);
      },
      next: () => latest.current.onNext(),
      back: () => latest.current.onBack(),
    };
  }, [step]);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setLoaderDue(true), COVER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSilent(true), props.silenceMs ?? STEP_SILENCE_MS);
    return () => clearTimeout(timer);
  }, [ready, props.silenceMs]);
  const missing = useCallback(() => latest.current.onSkip('not-needed'), []);
  const locked = covered || busy !== null;
  /** Next: a page with a save registered is saved first (rule 8); one without just moves on. Back and Later never save. */
  const pressNext = useCallback((): void => {
    const save = commit.current;
    if (save === null) {
      latest.current.onNext();
      return;
    }
    if (saving.current) return;
    saving.current = true;
    shown.current = true;
    setSaveError(null);
    setBusy('Saving…');
    // A save may throw while it is being prepared, before it hands back its promise: that is a failed save too.
    new Promise<void>(resolve => resolve(save()))
      .then(
        () => {
          if (!alive.current) return;
          latest.current.onDone();
          latest.current.onNext();
        },
        (error: unknown) => {
          if (alive.current) setSaveError(error instanceof Error ? error.message : 'That could not be saved.');
        },
      )
      .finally(() => {
        saving.current = false;
        if (alive.current) setBusy(now => (now === 'Saving…' ? null : now));
      });
  }, []);
  const pressBack = useCallback((): void => {
    commit.current = null;
    latest.current.onBack();
  }, []);
  return (
    <StepPageFrame
      title={step.title}
      {...(progress === undefined ? {} : { progress })}
      {...(canBack ? { back: { onClick: pressBack, disabled: busy !== null } } : {})}
      next={{ label: 'Next', disabled: locked, busy: busy !== null, hidden: held, onClick: pressNext }}
      {...(saveError === null
        ? {}
        : {
            note: (
              <p role="alert" className="fy-sf-note" data-flow-commit-error="">
                {saveError}
              </p>
            ),
          })}
      {...(!covered
        ? {
            later: {
              ...(props.laterLabel === undefined ? {} : { label: props.laterLabel }),
              title: 'Come back to this from Settings',
              disabled: busy !== null,
              onClick: props.onLater,
              marks: { 'data-flow-later': '' },
            },
          }
        : {})}
    >
      <div
        className="fy-sf-page"
        data-direction={direction}
        data-motion={moving ? '' : undefined}
        data-flow-page={step.key}
        data-ready={covered ? undefined : ''}
      >
        {covered ? null : <OnlyOnChip names={step.onlyOn} />}
        {covered ? (
          <div className="fy-sf-cover" data-flow-cover="">
            {loaderDue ? <Loading kind="page" label="Checking what this step needs…" /> : null}
            {silent && !ready ? (
              // C59 O8-4: a hint reads as a hint and the way out as a link (a quiet action, never a second button).
              <p className="fy-sf-silent fy-sf-hint" data-flow-silent="">
                Still checking.{' '}
                <button
                  type="button"
                  className="fy-inline-action"
                  onClick={() => props.onSkip('not-needed')}
                  data-flow-skip=""
                >
                  Skip this step
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="fy-sf-slot" hidden={covered} data-flow-slot="">
          {props.render === undefined ? (
            <PluginPage step={step} daemon={daemon} host={host} onMissing={missing} />
          ) : (
            props.render(host)
          )}
        </div>
        {busy === null ? null : (
          <p role="status" className="fy-sf-note" data-flow-busy="">
            {busy}
          </p>
        )}
        {unsaved === undefined ? null : (
          <div className="fy-sf-unsaved" data-flow-unsaved="">
            <p role="alert" className="fy-sf-note">
              {unsaved.count > 1 ? `${unsaved.count} answers were not saved.` : 'That answer was not saved.'}
            </p>
            <Button size="sm" onClick={unsaved.retry} data-flow-retry-save="">
              Try again
            </Button>
          </div>
        )}
      </div>
    </StepPageFrame>
  );
}
