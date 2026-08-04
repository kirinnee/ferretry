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
  /** Whether each part is what the current step acts on — lit rather than resting. */
  readonly lit: { readonly machine: boolean; readonly browser: boolean; readonly link: boolean };
  /** Whether the two ends are actually joined yet. */
  readonly linked: boolean;
  /** The figure's accessible name — the same fact, in a sentence. */
  readonly label: string;
}

const STATE: Record<OnboardingStepId, DiagramState> = {
  /*
   * THE AGENT PATH, DRAWN AS WHAT IT IS: the work is at the far end, and this
   * browser is not the thing doing it. The reader is looking at a prompt they are
   * about to carry to another machine, so the machine end is what is lit — the
   * one place on this route where somebody could believe the page is installing
   * something, and the figure says otherwise before a word is read.
   */
  brief: {
    machine: 'your agent works',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'An agent on the other machine installs Ferretry and starts its daemon. This browser is not linked yet.',
  },
  'agent-pair': {
    machine: 'showing QR',
    browser: 'scanning or pasting',
    lit: { machine: true, browser: true, link: true },
    linked: false,
    label: 'The agent has printed a fresh QR code and link on that machine, and this browser is using it.',
  },
  install: {
    machine: 'installing fy',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'Your machine, where Ferretry is being installed, is not yet linked to this browser.',
  },
  daemon: {
    machine: 'fyd running',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'The daemon is starting on your machine. This browser is not linked to it yet.',
  },
  /*
   * The one step that is about the LINE, not the ends. Choosing a carrier decides
   * how the two will reach each other, so the link is what lights up while both
   * ends rest — and it is still dashed, because deciding is not connecting.
   */
  connect: {
    machine: 'fyd running',
    browser: 'waiting',
    lit: { machine: false, browser: false, link: true },
    linked: false,
    label: 'Choosing how this browser will reach the daemon on your machine. They are not linked yet.',
  },
  'relay-fingerprint': {
    machine: 'showing identity',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'Your computer is showing the daemon fingerprint for a relay configuration. This browser is waiting.',
  },
  'relay-source': {
    machine: 'getting relay',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'Your computer is getting the relay deployment source. This browser is waiting.',
  },
  'relay-allow': {
    machine: 'configuring relay',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'Your computer is allowing its daemon at your relay. This browser is waiting.',
  },
  'relay-deploy': {
    machine: 'deploying relay',
    browser: 'waiting',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'Your computer is deploying the relay. This browser is waiting.',
  },
  /*
   * THE COLLAPSE, DRAWN. The daemon and this browser are the SAME machine, so
   * both ends light at once and the link is already solid — there is no journey
   * across the picture for a code to make. It is the one step whose figure says
   * "you are already here" before the reader has read a word of it.
   */
  local: {
    machine: 'fyd running',
    browser: 'same machine',
    lit: { machine: true, browser: true, link: true },
    linked: true,
    label: 'The daemon and this browser are the same machine, so they reach each other over loopback.',
  },
  /*
   * Nothing is happening on either end, and the figure must not pretend
   * otherwise: this device cannot be the machine, so the machine end is empty.
   */
  'need-computer': {
    machine: 'no terminal here',
    browser: 'waiting',
    lit: { machine: false, browser: true, link: false },
    linked: false,
    label: 'This device has no terminal, so it cannot run the daemon. Nothing is linked yet.',
  },
  /*
   * The link is live and the reader is being offered a SECOND browser. The
   * existing pair stays lit and joined — the offer costs them nothing they have.
   */
  handoff: {
    machine: 'fyd running',
    browser: 'adding a phone',
    lit: { machine: true, browser: true, link: true },
    linked: true,
    label: 'This browser is linked to the daemon, and a phone is being offered the same link.',
  },
  pair: {
    machine: 'showing QR',
    browser: 'get your phone',
    lit: { machine: true, browser: false, link: false },
    linked: false,
    label: 'On your computer, fy pair is showing a QR code and link. Take that fresh code to this browser next.',
  },
  scan: {
    machine: 'showing QR',
    browser: 'scanning or pasting',
    lit: { machine: true, browser: true, link: true },
    linked: false,
    label: 'Your computer is showing the fresh QR code while this browser scans it or pastes its link.',
  },
  done: {
    machine: 'fyd running',
    browser: 'linked',
    lit: { machine: true, browser: true, link: true },
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
        focused={state.lit.machine}
      />
      <DiagramLink focused={state.lit.link} linked={state.linked} />
      <DiagramNode
        icon={<Smartphone size={20} aria-hidden="true" />}
        title="this browser"
        detail={state.browser}
        focused={state.lit.browser}
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
