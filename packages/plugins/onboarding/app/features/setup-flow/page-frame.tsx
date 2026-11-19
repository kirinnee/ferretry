/**
 * ONE PAGE OF THE FLOW: the plugin's page, mounted under a loading cover, inside the shared step frame.
 *
 * The page is drawn by the plugin (`panel('onboarding.step')` for this step's subject) and handed a `StepHost` as its
 * `step` prop. The shell's rules, so no page can break the flow (contract/step-host.ts):
 *   1. the page is mounted at once but hidden under a cover ("Checking …") until it calls `ready()` or `skip()`; the cover
 *      and the page never show together, so nothing pops in;
 *   2. after STEP_SILENCE_MS of silence the cover adds "Skip this step": a page that never answers never blocks;
 *   3. `busy(label)` locks Next and says what is happening; `done()` is recorded once.
 * Next, Back and Later are the shell's, so every page has the same footer.
 */
import { PanelSlot, StepPageFrame, useSlotPanels } from '@ferretry/app';
import { Badge, Button, Loading, useMotionAllowed } from '@ferretry/app/ui';
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
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onLater: () => void;
  /** The answer the machine did not take, and the way to try again. */
  readonly unsaved?: { readonly retry: () => void } | undefined;
  /** Test seam: how long a page may stay silent. */
  readonly silenceMs?: number;
  /** What draws the page. The default is the plugin's own panel in the `onboarding.step` slot; a scene or test hands its own. */
  readonly render?: (host: StepHost) => ReactNode;
}

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
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  // The host is made once per page: its calls reach the latest callbacks through this ref.
  const latest = useRef(props);
  latest.current = props;
  const host = useMemo<StepHost>(
    () => ({
      phase: step.phase,
      appliesTo: step.appliesTo,
      get segment() {
        return latest.current.segment();
      },
      remember: patch => latest.current.remember(patch),
      ready: () => setReady(true),
      skip: why => latest.current.onSkip(why),
      done: () => latest.current.onDone(),
      busy: label => setBusy(label),
      next: () => latest.current.onNext(),
      back: () => latest.current.onBack(),
    }),
    [step],
  );
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSilent(true), props.silenceMs ?? STEP_SILENCE_MS);
    return () => clearTimeout(timer);
  }, [ready, props.silenceMs]);
  const missing = useCallback(() => latest.current.onSkip('not-needed'), []);
  const locked = !ready || busy !== null;
  return (
    <StepPageFrame
      title={step.title}
      {...(progress === undefined ? {} : { progress })}
      {...(canBack ? { back: { onClick: props.onBack } } : {})}
      next={{ label: 'Next', disabled: locked, busy: busy !== null, onClick: props.onNext }}
    >
      <div
        className="fy-sf-page"
        data-direction={direction}
        data-motion={moving ? '' : undefined}
        data-flow-page={step.key}
        data-ready={ready ? '' : undefined}
      >
        {ready ? <OnlyOnChip names={step.onlyOn} /> : null}
        {ready ? null : (
          <div className="fy-sf-cover" data-flow-cover="">
            <Loading kind="page" label="Checking what this step needs…" />
            {silent ? (
              <div className="fy-sf-silent" data-flow-silent="">
                <p className="fy-sf-note">Still checking…</p>
                <Button variant="ghost" onClick={() => props.onSkip('not-needed')} data-flow-skip="">
                  Skip this step
                </Button>
              </div>
            ) : null}
          </div>
        )}
        <div className="fy-sf-slot" hidden={!ready} data-flow-slot="">
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
              That answer was not saved.
            </p>
            <Button size="sm" onClick={unsaved.retry} data-flow-retry-save="">
              Try again
            </Button>
          </div>
        )}
        {ready ? (
          <Button
            variant="ghost"
            size="sm"
            className="fy-sf-later"
            title="Come back to this from Settings"
            onClick={props.onLater}
            data-flow-later=""
          >
            Later
          </Button>
        ) : null}
      </div>
    </StepPageFrame>
  );
}
