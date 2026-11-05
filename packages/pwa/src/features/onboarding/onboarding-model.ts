/**
 * Everything first-run KNOWS, with nothing it renders.
 *
 * The page is public and static: it cannot see the reader's terminal, so it can
 * never verify that a command worked. That single fact shapes this module —
 * every string here is either taken verbatim from `INSTALLATION.md`, the mounted
 * CLI commands, `Taskfile.yaml` or `docs/relay-protocol.md`, or it is an honest
 * instruction to go and look. Nothing is invented, and nothing claims a check
 * that did not happen.
 *
 * The commands live here rather than in the components because they are the part
 * that must not drift: the same block is displayed, copied, and pasted into the
 * agent prompt, so there is exactly one copy of each.
 *
 * THREE FACTS DRIVE THE WHOLE FLOW, AND ONLY ONE OF THEM IS A QUESTION.
 *
 * 1. A DAEMON RUNS ON A COMPUTER. It needs a terminal, so a phone can never host
 *    one. This is not a preference to be offered and refused two screens later.
 * 2. A CLIENT IS ANY BROWSER, and there may be as many as the reader likes.
 * 3. "IS THIS A PHONE" AND "HAS THIS BROWSER PAIRED BEFORE" ARE BOTH DETECTABLE.
 *    `device-kind.ts` answers the first and `first-run-entry.ts` the second, so
 *    neither is ever asked.
 *
 * SO THERE IS ONE SUBFLOW THAT MATTERS: GET A DAEMON RUNNING. Everything else
 * routes into it or pairs after it, and exactly two questions survive.
 *
 * - WHICH COMPUTER runs the daemon — this one, or another? Skipped on a phone,
 *   where the answer is forced; assumed on a computer starting from scratch,
 *   where it is right almost every time and escapable when it is not.
 * - WHO INSTALLS IT — an agent, or the reader? Always asked, because it changes
 *   every screen after it: an agent has the terminal and needs one prompt, and a
 *   reader typing the commands needs the commands.
 *
 * THE RECURSION IS THE SIMPLIFICATION. "Another computer, and I do it myself"
 * owns no screens of its own. It says to open this page on that computer, and
 * that computer walks the same subflow answering "this one" — so there is exactly
 * one place that teaches installation, and it is always teaching the machine the
 * reader is sitting at. Nothing here explains a remote install in the abstract.
 */

import type { DeviceKind } from './device-kind.ts';

/**
 * WHICH COMPUTER RUNS THE DAEMON — the first question, and a fact about the
 * arrangement rather than about this device.
 *
 * It replaced "what is this device?", which was the wrong question twice over: it
 * asked a phone something the page can already see, and it offered a phone the
 * one answer a phone can never be. What actually decides the journey is where the
 * daemon is going to live, and a browser is only ever a client of it.
 */
export type SetupTargetId = 'this' | 'other';

export interface SetupTarget {
  readonly id: SetupTargetId;
  readonly title: string;
  readonly answer: string;
}

const TARGETS: Readonly<Record<SetupTargetId, SetupTarget>> = Object.freeze({
  this: Object.freeze({
    id: 'this' as const,
    title: 'This computer',
    answer: 'Install here, in a terminal on this machine. This browser is then already a client of it.',
  }),
  other: Object.freeze({
    id: 'other' as const,
    title: 'Another computer',
    answer: 'A different machine runs the agents. You will set it up there, then pair this browser with it.',
  }),
});

/** Both answers, this-machine first: it is the shorter journey and the common one. */
export const SETUP_TARGETS: readonly SetupTarget[] = Object.freeze([TARGETS.this, TARGETS.other]);

/** Total, because the id is a closed union. */
export const setupTarget = (id: SetupTargetId): SetupTarget => TARGETS[id];

/** Whether a value read back from storage or a link is still one of the two answers. */
export const isSetupTargetId = (value: unknown): value is SetupTargetId =>
  typeof value === 'string' && Object.hasOwn(TARGETS, value);

/**
 * Whether this device could be the daemon at all.
 *
 * The one place the hardware fact is stated as a rule rather than assumed by a
 * caller. A stored document, a hand-off link or a mistyped URL proposing that a
 * phone hosts the daemon is proposing something impossible, and every reader of
 * that proposal has to refuse it the same way.
 */
export const isTargetPossible = (target: SetupTargetId, device: DeviceKind): boolean =>
  target === 'other' || device === 'desktop';

/**
 * WHO INSTALLS IT? — the second question, and the one that changes the most.
 *
 * An agent doing the setup has no platform picker, no commands on the glass and
 * no `fy pair` to run by hand: it has a terminal on the machine that becomes the
 * daemon, and all it needs is one prompt. A reader typing the commands needs
 * every one of those things. The question is asked on every device and on both
 * answers to the first one, because it is orthogonal to both.
 */
export type OnboardingDoerId = 'agent' | 'self';

export interface OnboardingDoer {
  readonly id: OnboardingDoerId;
  /** What the reader recognises themselves as. */
  readonly title: string;
  /** What happens if they pick it. One line, because the two are compared at a glance. */
  readonly answer: string;
}

/**
 * The two answers, agent first, WORDED FOR THE MACHINE THAT WAS ALREADY CHOSEN.
 *
 * Agent leads because it is the shorter journey and the one a reader with an
 * agent open in another window recognises instantly. Both name the machine
 * concretely — "this computer" or "that computer" — rather than the abstract
 * "machine that will run your agents" they used to share, because by this screen
 * the reader has answered which one it is and a reader who pastes the prompt into
 * an agent on the wrong host installs Ferretry on the wrong host.
 */
const DOERS: Readonly<Record<SetupTargetId, Readonly<Record<OnboardingDoerId, OnboardingDoer>>>> = Object.freeze({
  this: Object.freeze({
    agent: Object.freeze({
      id: 'agent' as const,
      title: 'An agent does it',
      answer: 'You already have Claude or Codex on this computer. Give it one prompt and watch.',
    }),
    self: Object.freeze({
      id: 'self' as const,
      title: 'I do it myself',
      answer: 'Copy commands into a terminal on this computer, one step at a time.',
    }),
  }),
  other: Object.freeze({
    agent: Object.freeze({
      id: 'agent' as const,
      title: 'An agent does it',
      answer: 'You have Claude or Codex on that computer. Send it one prompt from here.',
    }),
    self: Object.freeze({
      id: 'self' as const,
      title: 'I do it myself',
      answer: 'Open Ferretry on that computer. It walks you through it there, then this browser pairs.',
    }),
  }),
});

/** Both answers, in the order they are read, worded for the chosen machine. */
export const onboardingDoers = (target: SetupTargetId): readonly OnboardingDoer[] =>
  Object.freeze([DOERS[target].agent, DOERS[target].self]);

/** Total, because both ids are closed unions. */
export const onboardingDoer = (id: OnboardingDoerId, target: SetupTargetId = 'this'): OnboardingDoer =>
  DOERS[target][id];

/** Whether a value read back from storage or a link is still one of the two answers. */
export const isOnboardingDoerId = (value: unknown): value is OnboardingDoerId =>
  typeof value === 'string' && Object.hasOwn(DOERS.this, value);

/**
 * WHERE A READER COMES IN — an entry, not a question about this device.
 *
 * The first screen used to ask what this device was about to become, and offered
 * a phone "add this as a daemon" — an answer that cannot be true. These three are
 * about what the reader HAS, which is a thing only they know:
 *
 * - `first-time` — nothing exists yet. Enters the daemon subflow.
 * - `add-client` — they are holding a link or a QR. Short-circuits to pairing.
 * - `add-daemon` — they have a fleet and want one more machine. Enters the SAME
 *   subflow, so adding a daemon replays the full instructions for free.
 *
 * A browser that has already paired is asked none of it: `first-run-entry.ts`
 * sends it straight to its fleet.
 */
export type OnboardingRouteId = 'first-time' | 'add-client' | 'add-daemon';

/** The two entries that lead into the daemon subflow, and therefore into both questions. */
export type OnboardingDaemonRouteId = Exclude<OnboardingRouteId, 'add-client'>;

export interface OnboardingRoute {
  readonly id: OnboardingRouteId;
  /** What the reader recognises themselves as, in their own words. */
  readonly title: string;
  /** What happens if they pick it. One line, because three of them are compared at once. */
  readonly answer: string;
}

/**
 * The three entries, ordered as they are read.
 *
 * First-time leads because it is the only answer somebody who knows nothing yet
 * can recognise as theirs. The link answer is second because a reader holding a
 * live two-minute code is in a hurry. NONE of them varies by device any more:
 * none of them claims that THIS device becomes anything, so there is nothing for
 * a phone to be refused.
 */
const ROUTES: { readonly [Id in OnboardingRouteId]: OnboardingRoute & { readonly id: Id } } = Object.freeze({
  'first-time': Object.freeze({
    id: 'first-time' as const,
    title: 'Set up a computer',
    answer: 'Nothing installed yet.',
  }),
  'add-client': Object.freeze({
    id: 'add-client' as const,
    title: 'I have a QR or link',
    answer: 'Ferretry already runs somewhere.',
  }),
  'add-daemon': Object.freeze({
    id: 'add-daemon' as const,
    title: 'Add another computer',
    answer: 'Set up one more computer to run agents.',
  }),
});

/**
 * All three entries, in the order they are read.
 *
 * The chooser draws the first two as cards and the third as a small link: adding
 * a computer is an errand for somebody who already has a fleet, and the entry is
 * for the reader who has nothing yet.
 */
export const ONBOARDING_ROUTES: readonly OnboardingRoute[] = Object.freeze([
  ROUTES['first-time'],
  ROUTES['add-client'],
  ROUTES['add-daemon'],
]);

/** Total, because the id is a closed union. */
export const onboardingRoute = (id: OnboardingRouteId): OnboardingRoute => ROUTES[id];

/** Whether a value read back from storage or a link is still one of the routes we ship. */
export const isOnboardingRouteId = (value: unknown): value is OnboardingRouteId =>
  typeof value === 'string' && Object.hasOwn(ROUTES, value);

/** Whether this entry leads into the daemon subflow, and therefore has a target and a doer. */
export const isDaemonRouteId = (id: OnboardingRouteId): id is OnboardingDaemonRouteId => id !== 'add-client';

/** Every stage that any journey can put on the glass, in no particular order. */
export type OnboardingStepId = 'brief' | 'install' | 'local' | 'elsewhere' | 'handoff' | 'pair';

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  /** The page heading. */
  readonly title: string;
  /** One short line under the heading: what the reader does here, never a paragraph. */
  readonly summary: string;
}

/**
 * EVERY JOURNEY IS ONE PAGE, EXCEPT THE ONE WITH COMMANDS IN IT.
 *
 * A page the reader can finish by doing one thing is not three pages. The agent
 * answer, the pairing entry and "another computer" are each a single page now —
 * the instruction and the pairing surface sit together — and installing by hand
 * on this computer is three: install and start, open, and the optional phone.
 */
const STEPS: Readonly<Record<OnboardingStepId, OnboardingStep>> = Object.freeze({
  brief: Object.freeze({
    id: 'brief' as const,
    title: 'Let your agent set it up',
    summary: 'Copy the prompt and paste it into your agent.',
  }),
  install: Object.freeze({
    id: 'install' as const,
    title: 'Install and start',
    summary: 'Run this in a terminal on this computer.',
  }),
  local: Object.freeze({
    id: 'local' as const,
    title: 'Open Ferretry',
    summary: 'The daemon is on this computer, so there is nothing to scan.',
  }),
  elsewhere: Object.freeze({
    id: 'elsewhere' as const,
    title: 'Set it up on your computer',
    summary: 'Agents need a terminal, so the setup continues there.',
  }),
  handoff: Object.freeze({
    id: 'handoff' as const,
    title: 'Add your phone (optional)',
    summary: 'Your phone can watch this computer too.',
  }),
  pair: Object.freeze({
    id: 'pair' as const,
    title: 'Pair this device',
    summary: 'Run the command there, then scan the QR it shows.',
  }),
});

/** Total, because the id is a closed union. */
export const onboardingStep = (id: OnboardingStepId): OnboardingStep => STEPS[id];

/** Whether a value read back from storage is still one of the steps we ship. */
export const isOnboardingStepId = (value: unknown): value is OnboardingStepId =>
  typeof value === 'string' && Object.hasOwn(STEPS, value);

/**
 * EVERY DECISION THAT DECIDES A LIST OF STEPS, as a closed union.
 *
 * A UNION RATHER THAN OPTIONAL FIELDS, because the pairing entry genuinely has no
 * target and no doer while the daemon subflow cannot proceed without both. A
 * single record with optional fields is a record with states that must never
 * happen — `add-client` carrying a doer, `first-time` walking
 * an install step with nobody assigned to run it — and every reader of it would
 * have to decide what those mean. This shape cannot hold them, so nothing
 * downstream has to defend against them.
 */
export type OnboardingJourney =
  | { readonly route: 'add-client' }
  | {
      readonly route: OnboardingDaemonRouteId;
      readonly target: SetupTargetId;
      readonly doer: OnboardingDoerId;
    };

/**
 * A journey being walked BY A PARTICULAR DEVICE.
 *
 * The device is part of the path rather than a separate argument threaded through
 * nine helpers, because it is not an optional refinement: it forces the target
 * answer on a phone, and a helper that could be called without it would silently
 * answer for the wrong kind of machine.
 */
export type OnboardingPath = OnboardingJourney & { readonly device: DeviceKind };

/**
 * WHAT THIS DEVICE ALREADY ANSWERS FOR THE READER, and on what grounds.
 *
 * - `forced` — a phone. The hardware answers it, and there is no other answer to
 *   offer; the screen states the fact rather than asking.
 * - `assumed` — a computer starting from scratch. Almost everybody setting up for
 *   the first time is sitting at the machine they mean, so assuming makes the
 *   common path one question shorter — and the assumption is STATED, with a way
 *   out, because somebody standing up a home server must be able to say so.
 * - `chosen` — a computer adding another daemon. That reader has a fleet and a
 *   real choice between two machines they own, so guessing would be rude.
 */
export type TargetBasis = 'forced' | 'assumed' | 'chosen';

/** How this journey's target is decided before anybody is asked. */
export const targetBasis = (route: OnboardingDaemonRouteId, device: DeviceKind): TargetBasis =>
  device === 'mobile' ? 'forced' : route === 'first-time' ? 'assumed' : 'chosen';

/**
 * The target this device settles without asking, or `undefined` when the reader
 * has to answer. Total, and the single place the two presumptions live.
 */
export const presumedTarget = (route: OnboardingDaemonRouteId, device: DeviceKind): SetupTargetId | undefined => {
  const basis = targetBasis(route, device);
  if (basis === 'forced') return 'other';
  return basis === 'assumed' ? 'this' : undefined;
};

/**
 * Standing up a daemon ON THIS MACHINE, and the collapse that makes it short.
 *
 * The browser reading this page is running on the machine that is about to host
 * the daemon — that is what the answer MEANT. So it is already a client of it,
 * over loopback, and there is no QR to scan and no code to type: `fy pair --open`
 * on the same machine opens this app already paired. Making somebody photograph
 * their own screen is the single most common first-run indignity, and it exists
 * only because the old arc could not tell the two machines apart.
 *
 * THERE IS NO CARRIER QUESTION IN IT. Direct is attempted first and Ferretry's
 * hosted relay is the automatic fallback (`docs/relay-protocol.md` §13), so a
 * stranger is never asked to pick between direct, the hosted relay and a relay
 * of their own — a question they cannot answer and did not need to. Running
 * your own relay is an expert path with its own runbook,
 * `docs/cloudflare-relay-self-hosting.md`, and never a step here.
 */
const DAEMON_STEPS: readonly OnboardingStepId[] = Object.freeze(['install', 'local'] as OnboardingStepId[]);

/**
 * The pages this journey walks.
 *
 * - Pairing only: somebody arrived holding a code. One page.
 * - An agent: the prompt, with the pairing surface under it. One page.
 * - Another computer, by hand: the setup link, with the pairing surface under it.
 *   One page; that computer walks the list below, answering "this one".
 * - This computer, by hand: the only list with commands in it, and the only one
 *   that ends by offering a phone the same view.
 *
 * NONE OF THEM ENDS ON A "DONE" PAGE. Pairing succeeding is the end, and the
 * reader goes straight into the app.
 */
export const onboardingRouteSteps = (path: OnboardingPath): readonly OnboardingStepId[] => {
  if (path.route === 'add-client') return Object.freeze(['pair'] as OnboardingStepId[]);
  if (path.doer === 'agent') return Object.freeze(['brief'] as OnboardingStepId[]);
  if (path.target === 'other') return Object.freeze(['elsewhere'] as OnboardingStepId[]);
  return Object.freeze([...DAEMON_STEPS, ...(path.route === 'first-time' ? (['handoff'] as OnboardingStepId[]) : [])]);
};

/** Position within a journey, or `-1` for a step that journey never walks. */
export const onboardingStepIndex = (path: OnboardingPath, step: OnboardingStepId): number =>
  onboardingRouteSteps(path).indexOf(step);

/** Whether this step belongs to this journey on this device — the guard every stored pair must pass. */
export const isStepOfRoute = (path: OnboardingPath, step: OnboardingStepId): boolean =>
  onboardingStepIndex(path, step) >= 0;

/** How many pages this journey walks, for a header that has to say "step 2 of 3". */
export const onboardingStepCount = (path: OnboardingPath): number => onboardingRouteSteps(path).length;

/** The step a journey opens on. */
export const firstOnboardingStep = (path: OnboardingPath): OnboardingStepId => {
  const [first] = onboardingRouteSteps(path);
  /* Unreachable: every branch above ships at least one step, and each list is frozen. */
  return first ?? 'pair';
};

/** The next step of this journey, or the same one at the end of it. */
export const nextOnboardingStep = (path: OnboardingPath, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(path);
  return steps[Math.min(onboardingStepIndex(path, id) + 1, steps.length - 1)] ?? id;
};

/** The previous step of this journey, or the same one at the start of it. */
export const previousOnboardingStep = (path: OnboardingPath, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(path);
  return steps[Math.max(onboardingStepIndex(path, id) - 1, 0)] ?? id;
};

/** The later of two steps of one journey, so progress can only ever move forward. */
export const furthestOnboardingStep = (
  path: OnboardingPath,
  left: OnboardingStepId,
  right: OnboardingStepId,
): OnboardingStepId => (onboardingStepIndex(path, left) >= onboardingStepIndex(path, right) ? left : right);

/**
 * Whether this step is the last one on its journey, so finishing it means going into the app.
 *
 * There is no page after it: pairing, or the reader saying they are done, is the end.
 */
export const isLastOnboardingStep = (path: OnboardingPath, step: OnboardingStepId): boolean =>
  onboardingStepIndex(path, step) === onboardingStepCount(path) - 1;

/** The three screens that can be behind the reader, in the order they are asked. */
export type OnboardingQuestion = 'entry' | 'target' | 'doer';

/**
 * WHICH QUESTION IS BEHIND THIS JOURNEY'S FIRST STEP — the one Back has to reach.
 *
 * The pairing entry was opened by the entry chooser itself; every daemon journey
 * was opened by answering who installs it. Returning a reader to a question they
 * never answered is how a two-question flow starts feeling like a maze, and it is
 * a fact about the journey rather than a decision for the page to make twice.
 */
export const questionBehindRoute = (route: OnboardingRouteId): OnboardingQuestion =>
  route === 'add-client' ? 'entry' : 'doer';

/**
 * WHICH QUESTION IS BEHIND THE DOER QUESTION, which depends on whether the
 * target was asked at all. A `Back` that lands on a question the reader never saw
 * is the same defect as one that skips the question they did answer.
 */
export const questionBehindDoer = (route: OnboardingDaemonRouteId, device: DeviceKind): OnboardingQuestion =>
  presumedTarget(route, device) === undefined ? 'target' : 'entry';

/** Which device a hand-off is aimed at, which is what decides how it can travel. */
export type HandoffReceiver = 'computer' | 'phone';

/**
 * WHERE A HAND-OFF FROM THIS JOURNEY SHOULD DROP THE OTHER DEVICE.
 *
 * The asymmetry is the whole point, and it is about the RECEIVER rather than the
 * sender: a phone can read a computer's screen with its camera, and nothing on a
 * desk is pointing a camera at anything. So a hand-off to a phone can be a QR and
 * a hand-off to a computer has to be words.
 *
 * - A journey whose daemon lives elsewhere hands the daemon half to that
 *   COMPUTER, which walks the same subflow answering "this one" and installing by
 *   hand — the recursion that means installation is taught in exactly one place.
 * - A computer that has just paired itself has nothing left to hand over except
 *   membership, so it hands a PHONE the pairing entry, at the step where somebody
 *   must run `fy pair` — which, at that moment, is the computer doing the handing.
 */
export const handoffTarget = (
  path: OnboardingPath,
): {
  readonly receiver: HandoffReceiver;
  readonly journey: OnboardingJourney;
  readonly step: OnboardingStepId;
} =>
  path.route !== 'add-client' && path.target === 'other'
    ? {
        receiver: 'computer',
        journey: { route: path.route, target: 'this', doer: 'self' },
        step: 'install',
      }
    : { receiver: 'phone', journey: { route: 'add-client' }, step: 'pair' };

/* ---------- install channels, verbatim from INSTALLATION.md ---------------- */

export type InstallChannelId = 'apt' | 'dnf' | 'brew' | 'nix' | 'curl';

export interface InstallChannel {
  readonly id: InstallChannelId;
  /** What the reader recognises their own machine as. */
  readonly label: string;
  /**
   * ONE copyable block, even when it is several lines.
   *
   * Two blocks side by side read as two decisions; a route that needs three
   * commands still only needs one copy, one paste and one press of Enter.
   */
  readonly command: string;
  /**
   * The route that works when none of the named ones do.
   *
   * Flagged rather than inferred from position, because it is the FALLBACK that
   * has to be labelled as one: a `curl … | bash` line offered beside "macOS" as
   * though the two were equal choices sends Mac owners down the unsigned path
   * while `brew`, which clears the Gatekeeper quarantine for them, sits one tap
   * away. The component gives it its own full-width row for the same reason.
   */
  readonly fallback?: true;
}

/**
 * The five documented install routes.
 *
 * Copied character for character out of `INSTALLATION.md`, which
 * `scripts/validate/cli-contracts.sh` pins — a paraphrase here would be a
 * command that has never been tested. macOS is arm64-only upstream, so no Intel
 * option is offered. The Nix route is the flake's default package, which
 * `nix/ferretry.nix` builds as a `symlinkJoin` of `fy` and `fyd`.
 */
const CHANNELS: Readonly<Record<InstallChannelId, InstallChannel>> = Object.freeze({
  apt: Object.freeze({
    id: 'apt' as const,
    label: 'Debian / Ubuntu',
    command: [
      'echo "deb [trusted=yes] https://apt.fury.io/kirinnee97/ /" | sudo tee /etc/apt/sources.list.d/fury.list',
      'sudo apt update',
      'sudo apt install fy',
    ].join('\n'),
  }),
  dnf: Object.freeze({
    id: 'dnf' as const,
    label: 'Fedora / RHEL',
    command: [
      "sudo tee /etc/yum.repos.d/fury.repo <<'EOF'",
      '[fury]',
      'name=Gemfury kirinnee97',
      'baseurl=https://yum.fury.io/kirinnee97/',
      'enabled=1',
      'gpgcheck=0',
      'EOF',
      'sudo dnf install fy',
    ].join('\n'),
  }),
  brew: Object.freeze({
    id: 'brew' as const,
    label: 'macOS',
    command: ['brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry', 'brew install --cask ferretry'].join(
      '\n',
    ),
  }),
  nix: Object.freeze({
    id: 'nix' as const,
    label: 'Nix',
    command: 'nix profile install github:kirinnee/ferretry',
  }),
  curl: Object.freeze({
    id: 'curl' as const,
    label: 'Anything else (script)',
    command:
      'curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash',
    fallback: true as const,
  }),
});

/** Every documented route, in switcher order. */
export const INSTALL_CHANNELS: readonly InstallChannel[] = Object.freeze([
  CHANNELS.apt,
  CHANNELS.dnf,
  CHANNELS.brew,
  CHANNELS.nix,
  CHANNELS.curl,
]);

/** Total, because the id is a closed union — an unknown channel cannot be constructed. */
export const installChannel = (id: InstallChannelId): InstallChannel => CHANNELS[id];

/* ---------- the agents Ferretry runs, which are not Ferretry ---------------- */

/**
 * FERRETRY RUNS CODING AGENTS; IT IS NOT ONE. With neither installed, the daemon
 * starts perfectly and can do nothing at all — so onboarding that ends at a paired
 * app has walked somebody to a fleet that cannot run a single session.
 *
 * THESE COMMANDS ARE NOT PINNED THE WAY `INSTALL_CHANNELS` IS, and that asymmetry
 * is worth stating rather than hiding. Ferretry's own commands are asserted
 * character-for-character against `INSTALLATION.md`, which
 * `scripts/validate/cli-contracts.sh` holds to the release; these two belong to
 * other people's products, and nothing in this repository can prove they still
 * work. So the page names the vendor as the authority, and the check command
 * beside each one is what actually tells the reader anything.
 *
 * The ids are the two families `HarnessSchema` ships in `@ferretry/protocol`
 * (`claude`, `codex`), and the executable names are what a fresh fleet manifest
 * points at. It is deliberately not imported: this is a public page describing two
 * third-party tools, and it must not acquire a build dependency on the wire
 * protocol to say their names.
 */
export interface AgentHarness {
  readonly id: 'claude' | 'codex';
  /** What the reader calls it. */
  readonly label: string;
  /** How its own documentation installs it. */
  readonly command: string;
  /**
   * What proves it landed — AND NOTHING MORE THAN THAT.
   *
   * A version on stdout means the executable is on `PATH`. It does not mean the
   * reader is signed in, that a subscription is live, or that a single prompt
   * would be answered. Every string near this one has to respect that gap.
   */
  readonly check: string;
}

const HARNESSES: Readonly<Record<AgentHarness['id'], AgentHarness>> = Object.freeze({
  claude: Object.freeze({
    id: 'claude' as const,
    label: 'Claude Code',
    command: 'npm install -g @anthropic-ai/claude-code',
    check: 'claude --version',
  }),
  codex: Object.freeze({
    id: 'codex' as const,
    label: 'Codex',
    command: 'npm install -g @openai/codex',
    check: 'codex --version',
  }),
});

/**
 * Both, in the order they are read — and AT LEAST ONE is the bar.
 *
 * Not "both are required", which is what a page listing two commands with no
 * qualifier says by implication. A fleet with one Claude account runs perfectly.
 */
export const AGENT_HARNESSES: readonly AgentHarness[] = Object.freeze([HARNESSES.claude, HARNESSES.codex]);

/** Total, because the id is a closed union. */
export const agentHarness = (id: AgentHarness['id']): AgentHarness => HARNESSES[id];

/** Proves the install landed. */
export const VERIFY_COMMAND = 'fy --version';
/** Starts the daemon and waits until it serves. */
export const DAEMON_START_COMMAND = 'fy daemon start';
/** Installs the user service so the daemon comes back after a reboot. */
export const DAEMON_INSTALL_COMMAND = 'fy daemon install';
/** The one honest liveness answer: it probes the daemon's health endpoint. */
export const DAEMON_STATUS_COMMAND = 'fy daemon status';
/** Mints the single-use code this browser redeems. */
export const PAIR_COMMAND = 'fy pair';
/**
 * Pairs the browser ON THIS MACHINE, with nothing to scan.
 *
 * The daemon mints the same single-use link it puts in the QR and this opens it
 * in the host's own browser, so a reader whose daemon and browser are the same
 * machine never photographs their own screen. It is the CLI half of the
 * same-machine collapse; without it that collapse is a claim rather than a
 * behaviour.
 */
export const PAIR_OPEN_COMMAND = 'fy pair --open';
/** What a serving daemon prints, so the reader knows what they are looking for. */
export const DAEMON_SERVING_OUTPUT = 'fyd is serving';

/** Indents a copyable block so the prompt stays readable as one pasted message. */
function toPromptLines(block: string): readonly string[] {
  return block.split('\n').map(line => `     ${line}`);
}

/**
 * HOW THE AGENT REPORTS BACK, which the first question has already settled.
 *
 * The prompt used to make the agent ASK whether the human was reading this page
 * on the daemon's own machine, because it could not know and because guessing
 * spends a single-use code. It no longer has to guess: the reader answered which
 * computer runs the daemon before they were offered an agent at all, so the
 * prompt states the fact and names one pairing command.
 *
 * The `--open` branch keeps its fallback, and that is not hedging: a headless
 * box, a remote shell or a locked-down desktop cannot launch a browser, and an
 * agent that hits that with no instructions stops on the one step the human
 * cannot do for it.
 */
const reportBack = (target: SetupTargetId, step: number): readonly string[] =>
  target === 'this'
    ? [
        `${step}. Pair the browser on this machine: ${PAIR_OPEN_COMMAND}. It opens Ferretry in this machine's`,
        '   own browser, already paired, and there is nothing for me to type.',
        `   - If it reports that it cannot open a browser, run ${PAIR_COMMAND} instead and show me the QR`,
        '     code and the pairing link it prints, exactly as printed.',
      ]
    : [
        `${step}. I am reading the Ferretry setup page on a different device, so run ${PAIR_COMMAND} and show`,
        '   me the QR code and the pairing link it prints, exactly as printed, so I can scan or paste it',
        '   there. The code is single-use and expires in about two minutes, so show it as soon as it appears.',
      ];

/**
 * THE STEP THAT ASKS THE AGENT TO CHECK ITSELF, AND NOT TO REINSTALL ITSELF.
 *
 * The prompt is being pasted INTO Claude or Codex, so the reader of this text is by
 * definition one of the two things it is about — which is why it says CONFIRM. The
 * failure to design against is not subtle: an agent that reads "install a harness"
 * and dutifully installs the harness it already IS produces a screenshot nobody
 * wants to see, and tells the human nothing they did not know.
 *
 * SO THE FIRST THING IT SAYS IS "YOU ARE ONE OF THEM", and the instruction to
 * install is guarded twice — by naming it a check rather than an install, and by
 * gating it on NEITHER command answering.
 *
 * IT IS STILL NOT OBVIOUSLY FINE, which is the reason to check rather than assume:
 * Ferretry launches an EXECUTABLE, so what matters is `claude` or `codex` on this
 * machine's `PATH` — not the route by which an agent happens to be reaching the
 * human. An IDE extension, a wrapper or a remote session all arrive without either
 * executable being there, and in that case installing one is exactly right.
 *
 * AND IT REFUSES TO SIGN ANYBODY IN. A version string proves an executable exists;
 * it says nothing about an account. An agent that tried to authenticate on the
 * human's behalf would be doing the one thing on this page nobody delegated — and
 * somebody who is on `PATH` but not authenticated otherwise meets a baffling
 * failure at the moment they first try to run an agent, which is the worst possible
 * moment to learn it.
 */
const confirmHarness = (step: number): readonly string[] => [
  `${step}. Confirm this machine can actually run agents. Ferretry RUNS Claude Code and Codex — it is`,
  '   neither of them — and a daemon with both missing starts perfectly and can run nothing.',
  '   - YOU ARE ONE OF THEM, so this is a check and not an install. If your own command answers, you',
  '     are the harness: do not reinstall yourself.',
  '   - It can still be missing, which is why you check rather than assume. Ferretry launches an',
  "     EXECUTABLE, so what matters is one of these on this machine's PATH — not the way you happen",
  '     to be reaching me. An IDE extension, a wrapper or a remote session all arrive without it.',
  `   - Run ${AGENT_HARNESSES.map(harness => harness.check).join(' and ')}. If at least one answers, that is`,
  '     enough — tell me which one, and go on.',
  '   - ONLY if neither answers, install exactly one of these and tell me which you chose:',
  '',
  /* Nested one level deeper than the `fy` channels above, because it is inside a sub-bullet. */
  ...AGENT_HARNESSES.flatMap(harness => [`     ${harness.label}:`, `       ${harness.command}`, '']),
  '   - Being on PATH is not being signed in, and signing in is mine to do. If the one you found or',
  '     installed still needs an account, say so plainly instead of attempting it — I would rather',
  '     hear it now than meet it the first time I try to run something.',
];

/**
 * A public, self-contained brief for an AI coding agent — THE PRODUCT of the
 * agent answer, not a convenience beside it.
 *
 * The reader asked for a prompt they can paste into whatever agent already has a
 * terminal on the target machine. It therefore describes a STRANGER'S machine:
 * it names no host, no user, no daemon and no fleet, because this page is served
 * to anyone and this text is baked into the bundle. It also refuses to improvise
 * — an agent that cannot follow it must stop and report, since a half-installed
 * daemon is worse than an unstarted one.
 *
 * IT MUST SAY HOW TO REPORT BACK, or the person who pasted it is left wondering
 * whether anything worked. Which report to use is a function of the answer to the
 * first question, so it is a function argument here.
 *
 * THE HARNESS CHECK COMES BEFORE THE DAEMON, for the same reason the reader's own
 * list puts it there: the daemon reports what it can see at boot, so it should be
 * booting into a machine that is already able to run something.
 */
export const agentSetupPrompt = (target: SetupTargetId): string =>
  [
    'Set up Ferretry on this machine. Ferretry is a CLI (`fy`) plus a local daemon (`fyd`) that runs',
    'coding agents on this machine; a web page pairs with the daemon later. Follow these steps exactly',
    'and do not substitute commands of your own.',
    '',
    '1. Detect the operating system and CPU architecture. Supported targets are Linux amd64,',
    '   Linux arm64 and macOS arm64. If this machine is not one of those, stop and tell me.',
    '2. Install using exactly ONE of the documented commands below, whichever matches this machine.',
    '',
    ...INSTALL_CHANNELS.flatMap(channel => [`   ${channel.label}:`, ...toPromptLines(channel.command), '']),
    `3. Verify the install: ${VERIFY_COMMAND}`,
    ...confirmHarness(4),
    `5. Start the daemon: ${DAEMON_START_COMMAND}`,
    `6. Confirm it is running: ${DAEMON_STATUS_COMMAND} — it should print "${DAEMON_SERVING_OUTPUT}".`,
    ...reportBack(target, 7),
    '',
    'If any command fails, stop and report the exact command and the exact error. Do not improvise a',
    'workaround, do not install from an undocumented source, and do not edit configuration to route',
    'around a failure.',
  ].join('\n');

/**
 * The install route to show first, guessed from the user agent.
 *
 * A guess, not a claim — every other route stays one tap away, because the
 * machine being set up is frequently NOT the one holding this page: a phone that
 * scanned the QR is pointing at a laptop. Phones therefore resolve to the route
 * most likely to work on the machine they are standing next to: an iPhone's
 * owner is probably at a Mac, an Android's owner probably at Linux. Anything
 * unrecognised gets the one-line installer, which is the only route that works
 * on every supported target.
 */
export const detectInstallChannel = (userAgent: string | undefined): InstallChannelId => {
  const agent = (userAgent ?? '').toLowerCase();
  if (agent.includes('mac') || agent.includes('iphone') || agent.includes('ipad')) return 'brew';
  if (agent.includes('ubuntu') || agent.includes('debian')) return 'apt';
  if (agent.includes('fedora') || agent.includes('red hat') || agent.includes('centos')) return 'dnf';
  return 'curl';
};
