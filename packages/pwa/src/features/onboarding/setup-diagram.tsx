/**
 * THE WHOLE ARRANGEMENT, IN ONE GLANCE: your machine on the left, this browser
 * on the right, and a link between them that is not live yet.
 *
 * It replaces a sentence — "Ferretry runs on your own machine, and this page is
 * only a window onto it" — with the picture that sentence was describing. That
 * is a straight trade for a reader who parses shapes faster than prose, and it
 * does something the sentence could not: it also shows WHICH END the current
 * step is about, so the reader knows where to look before reading anything.
 *
 * State is carried by shape and by text, never by hue alone — a node is either
 * outlined or filled, the link is either dashed or solid, and the whole figure
 * has a single label that says the same thing in words.
 */

import { Check, Laptop, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';

import type { OnboardingStepId } from './onboarding-model.ts';

/** What each end is doing, per step. Three words each, at most. */
interface DiagramState {
  /** Under the machine. */
  readonly machine: string;
  /** Under the browser. */
  readonly browser: string;
  /** Which end the current step acts on, so attention lands there first. */
  readonly focus: 'machine' | 'browser' | 'link';
  /** Whether the two ends are actually joined yet. */
  readonly linked: boolean;
  /** The figure's accessible name — the same fact, in a sentence. */
  readonly label: string;
}

const STATE: Record<OnboardingStepId, DiagramState> = {
  install: {
    machine: 'installing fy',
    browser: 'waiting',
    focus: 'machine',
    linked: false,
    label: 'Your machine, where Ferretry is being installed, is not yet linked to this browser.',
  },
  daemon: {
    machine: 'fyd running',
    browser: 'waiting',
    focus: 'machine',
    linked: false,
    label: 'The daemon is starting on your machine. This browser is not linked to it yet.',
  },
  pair: {
    machine: 'fyd running',
    browser: 'pairing',
    focus: 'link',
    linked: false,
    label: 'Your machine is running the daemon and this browser is being linked to it.',
  },
  done: {
    machine: 'fyd running',
    browser: 'linked',
    focus: 'browser',
    linked: true,
    label: 'This browser is linked to the daemon running on your machine.',
  },
};

const NODE = 'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-control border px-1 py-2 text-center';

const NODE_TONE = {
  focused: 'border-accent bg-accent-bg text-fg',
  resting: 'border-border bg-surface-2 text-muted',
} as const;

export interface SetupDiagramProps {
  readonly step: OnboardingStepId;
}

export function SetupDiagram({ step }: SetupDiagramProps) {
  const state = STATE[step];
  return (
    // One label for the whole figure: the inner text is hidden from assistive
    // technology so the picture is announced once, as a sentence, rather than
    // as six disconnected fragments.
    <div role="img" aria-label={state.label} className="flex items-stretch gap-1" data-onboarding-diagram={step}>
      <DiagramNode
        icon={<Laptop size={20} aria-hidden="true" />}
        title="your machine"
        detail={state.machine}
        focused={state.focus === 'machine'}
      />
      <DiagramLink focused={state.focus === 'link'} linked={state.linked} />
      <DiagramNode
        icon={<Smartphone size={20} aria-hidden="true" />}
        title="this browser"
        detail={state.browser}
        focused={state.focus === 'browser'}
      />
    </div>
  );
}

interface DiagramNodeProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly focused: boolean;
}

function DiagramNode({ icon, title, detail, focused }: DiagramNodeProps) {
  return (
    <div className={`${NODE} ${focused ? NODE_TONE.focused : NODE_TONE.resting}`} aria-hidden="true">
      <span className={focused ? 'text-accent' : 'text-faint'}>{icon}</span>
      <span className="w-full truncate text-meta font-semibold">{title}</span>
      <span className="w-full truncate text-2xs text-faint">{detail}</span>
    </div>
  );
}

/**
 * The link between the two ends.
 *
 * Dashed until it exists, solid with a tick once it does — the same
 * shape-not-colour rule the step track follows, so an unpaired browser can
 * never look paired in a theme that flattens the accent.
 */
function DiagramLink({ focused, linked }: { readonly focused: boolean; readonly linked: boolean }) {
  const tone = linked || focused ? 'border-accent text-accent' : 'border-border text-faint';
  return (
    <div className="flex w-8 shrink-0 flex-col items-center justify-center gap-1" aria-hidden="true">
      <span className={`w-full border-t ${linked ? 'border-solid' : 'border-dashed'} ${tone}`} />
      <span className={`text-2xs ${tone}`}>{linked ? <Check size={12} strokeWidth={3} /> : '···'}</span>
    </div>
  );
}
