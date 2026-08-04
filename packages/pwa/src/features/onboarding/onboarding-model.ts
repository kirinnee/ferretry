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
 * THE FIRST QUESTION IS WHO DOES THE WORK, AND THE SECOND IS ABOUT THE DEVICE.
 * If an agent does the setup the whole journey is different — no platform picker,
 * no commands to copy, no `fy pair` to run by hand, and nothing left to ask about
 * this device, because the agent is ON the machine that becomes the daemon and
 * this browser is therefore the client. Only a reader who is typing the commands
 * themselves is asked the device question: Ferretry has two roles — a daemon that
 * runs agents and needs a terminal, and a client that only watches — and which of
 * those this device is about to become decides both the steps AND whether some of
 * them are possible here at all. A route therefore owns its own list of steps,
 * and that list is a function of the device as much as of the answer.
 */

import type { DeviceKind } from './device-kind.ts';

/**
 * WHO IS DOING THIS? — the first question, and the one that changes the most.
 *
 * It was an aside on the install step for one release, on the argument that
 * letting an agent do it is merely a way of PERFORMING that step. That was wrong.
 * An agent path has no platform picker, no commands on the glass, no `fy pair` to
 * run by hand and no device question at all — the agent is on the target machine,
 * so that machine is the daemon and this browser is the client. It is a different
 * journey, not a shortcut through the same one, and a difference that large
 * belongs before everything it changes.
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
 * The two answers, agent first.
 *
 * Agent leads because it is the shorter journey and the one a reader with an
 * agent open in another window will recognise instantly; "I do it myself" is the
 * answer that needs no recognising at all. Both name THE MACHINE THAT WILL RUN
 * YOUR AGENTS rather than "this machine": on the agent path the work happens
 * somewhere else, and a reader who misses that pastes a prompt into the wrong
 * terminal.
 */
const DOERS: Readonly<Record<OnboardingDoerId, OnboardingDoer>> = Object.freeze({
  agent: Object.freeze({
    id: 'agent' as const,
    title: 'An agent does it',
    answer: 'You already have Claude or Codex on the machine that will run your agents. Give it one prompt.',
  }),
  self: Object.freeze({
    id: 'self' as const,
    title: 'I do it myself',
    answer: 'Copy commands into a terminal on the machine that will run your agents, one step at a time.',
  }),
});

/** Both answers, in the order they are read. */
export const ONBOARDING_DOERS: readonly OnboardingDoer[] = Object.freeze([DOERS.agent, DOERS.self]);

/** Total, because the id is a closed union. */
export const onboardingDoer = (id: OnboardingDoerId): OnboardingDoer => DOERS[id];

/** Whether a value read back from storage or a link is still one of the two answers. */
export const isOnboardingDoerId = (value: unknown): value is OnboardingDoerId =>
  typeof value === 'string' && Object.hasOwn(DOERS, value);

/**
 * WHAT IS THIS DEVICE, AND WHAT IS IT FOR? — the question the second screen asks.
 *
 * The first version of this screen asked what the reader was HOLDING: a link, no
 * link, or an agent. That is not a fact about the system. Ferretry has exactly
 * two roles — a DAEMON, a machine that runs agents and needs a terminal, and a
 * CLIENT, a browser that watches one — and every real question is about which of
 * those this device is about to become. One machine can be both, and the ordinary
 * desktop first run is exactly that.
 *
 * `agent` is a route rather than a fourth answer to that question: nobody is ever
 * shown it beside the three, because choosing it is what makes the device
 * question disappear. That is a TYPE, not a convention — the device question is
 * handed `OnboardingDeviceRouteId`s, so an agent row cannot be added to it by
 * accident.
 */
export type OnboardingDeviceRouteId = 'first-time' | 'add-client' | 'add-daemon';

export type OnboardingRouteId = 'agent' | OnboardingDeviceRouteId;

/** Every stage that any route can put on the glass, in no particular order. */
export type OnboardingStepId =
  | 'brief'
  | 'agent-pair'
  | 'install'
  | 'daemon'
  | 'connect'
  | 'relay-fingerprint'
  | 'relay-source'
  | 'relay-allow'
  | 'relay-deploy'
  | 'local'
  | 'need-computer'
  | 'handoff'
  | 'pair'
  | 'scan'
  | 'done';

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  /** The step heading. */
  readonly title: string;
  /** The track label. One word, because up to five of them share a 390px row. */
  readonly short: string;
  /**
   * One short line under the heading.
   *
   * Never a paragraph, and never a sentence either: the diagram beside it
   * already says where the work happens, so this says only what the reader does.
   */
  readonly summary: string;
}

const STEPS: Readonly<Record<OnboardingStepId, OnboardingStep>> = Object.freeze({
  brief: Object.freeze({
    id: 'brief' as const,
    title: 'Give your agent the prompt',
    short: 'Prompt',
    summary: 'Copy it, then paste it into your agent on that machine.',
  }),
  'agent-pair': Object.freeze({
    id: 'agent-pair' as const,
    title: 'Pair when your agent is done',
    short: 'Pair',
    summary: 'It shows you a QR code and a link. Use them here.',
  }),
  install: Object.freeze({
    id: 'install' as const,
    title: 'Install Ferretry',
    short: 'Install',
    summary: 'Run this in a terminal on this machine.',
  }),
  daemon: Object.freeze({
    id: 'daemon' as const,
    title: 'Start the daemon',
    short: 'Daemon',
    summary: 'Leave it running. It does the work.',
  }),
  connect: Object.freeze({
    id: 'connect' as const,
    title: 'Choose a connection',
    short: 'Connect',
    summary: 'Choose how other devices will reach this machine.',
  }),
  'relay-fingerprint': Object.freeze({
    id: 'relay-fingerprint' as const,
    title: 'Get its fingerprint',
    short: 'Fingerprint',
    summary: 'Print the daemon identity your relay will allow.',
  }),
  'relay-source': Object.freeze({
    id: 'relay-source' as const,
    title: 'Get relay source',
    short: 'Source',
    summary: 'Get the deployment source.',
  }),
  'relay-allow': Object.freeze({
    id: 'relay-allow' as const,
    title: 'Allow your daemon',
    short: 'Allow',
    summary: 'Add that fingerprint to your relay configuration.',
  }),
  'relay-deploy': Object.freeze({
    id: 'relay-deploy' as const,
    title: 'Deploy your relay',
    short: 'Deploy',
    summary: 'Deploy the Cloudflare Worker from your account.',
  }),
  local: Object.freeze({
    id: 'local' as const,
    title: 'Open it from your terminal',
    short: 'Open',
    summary: 'The daemon is on this machine, so there is nothing to scan.',
  }),
  'need-computer': Object.freeze({
    id: 'need-computer' as const,
    title: 'You will need a computer',
    short: 'Computer',
    summary: 'Agents run in a terminal, and this device does not have one.',
  }),
  handoff: Object.freeze({
    id: 'handoff' as const,
    title: 'Add your phone',
    short: 'Phone',
    summary: 'Optional. Your phone can watch this machine too.',
  }),
  pair: Object.freeze({
    id: 'pair' as const,
    title: 'Run fy pair',
    short: 'Pair',
    summary: 'On the computer running the daemon, print a fresh code.',
  }),
  scan: Object.freeze({
    id: 'scan' as const,
    title: 'Scan QR or paste link',
    short: 'Scan',
    summary: 'On this device, use the fresh code from that computer.',
  }),
  done: Object.freeze({
    id: 'done' as const,
    title: 'You are set up',
    short: 'Done',
    summary: 'This browser is a window onto your machine.',
  }),
});

/** Total, because the id is a closed union. */
export const onboardingStep = (id: OnboardingStepId): OnboardingStep => STEPS[id];

export interface OnboardingRoute {
  readonly id: OnboardingRouteId;
  /** What the reader recognises themselves as, in their own words. */
  readonly title: string;
  /** What happens if they pick it. One line, because three of them are compared at once. */
  readonly answer: string;
}

/** A route the DEVICE question may offer. The agent route is not one of them. */
export interface OnboardingDeviceRoute extends OnboardingRoute {
  readonly id: OnboardingDeviceRouteId;
}

/**
 * Every route, including the one the device question never offers.
 *
 * The three device answers are ordered as they are read, and NOT "simplest first"
 * or "most common first": first-time setup leads because it is the only answer
 * somebody who knows nothing yet can recognise as theirs, and the other two are
 * for readers who already have a fleet and know exactly which half they are
 * adding. `agent` is not among them — it is reached by answering the FIRST
 * question, and its title exists for the one line above every step that names
 * which journey the reader is on.
 */
const ROUTES: { readonly [Id in OnboardingRouteId]: OnboardingRoute & { readonly id: Id } } = Object.freeze({
  agent: Object.freeze({
    id: 'agent' as const,
    title: 'An agent sets it up',
    answer: 'An agent on the machine that will run your agents installs Ferretry and starts its daemon.',
  }),
  'first-time': Object.freeze({
    id: 'first-time' as const,
    title: 'First time setup',
    answer: 'Nothing installed yet. Set up a machine to run agents, and this browser to watch it.',
  }),
  'add-client': Object.freeze({
    id: 'add-client' as const,
    title: 'Add this as a client',
    answer: 'A daemon already exists somewhere. This browser will watch it.',
  }),
  'add-daemon': Object.freeze({
    id: 'add-daemon' as const,
    title: 'Add this as a daemon',
    answer: 'This machine will run agents. Needs a terminal.',
  }),
});

/**
 * What the third answer says on a device that cannot host a daemon.
 *
 * NOT hidden: a reader who came here to add a machine must still find out what
 * became of that answer, and an option that silently vanishes reads as a bug in
 * the page rather than as a fact about the phone. It is offered, it says plainly
 * why it cannot happen here, and choosing it hands the job to a computer.
 */
const DAEMON_ON_MOBILE: OnboardingRoute & { readonly id: 'add-daemon' } = Object.freeze({
  id: 'add-daemon' as const,
  title: 'Add a daemon',
  answer: 'Agents run in a terminal, so this needs a computer. Send the setup there.',
});

/** Total, because the id is a closed union. */
export const onboardingRoute = (id: OnboardingRouteId, device: DeviceKind = 'desktop'): OnboardingRoute =>
  id === 'add-daemon' && device === 'mobile' ? DAEMON_ON_MOBILE : ROUTES[id];

/** The three DEVICE answers as this device should read them. Never the agent route. */
export const onboardingRoutes = (device: DeviceKind): readonly OnboardingDeviceRoute[] =>
  Object.freeze([
    ROUTES['first-time'],
    ROUTES['add-client'],
    device === 'mobile' ? DAEMON_ON_MOBILE : ROUTES['add-daemon'],
  ]);

/**
 * WHICH QUESTION IS BEHIND THIS ROUTE — the one Back has to reach.
 *
 * The agent route was opened by answering who does the work, so backing out of it
 * lands on that question; the three device routes were opened one question later.
 * Returning a reader to a question they never answered is how a two-question flow
 * starts feeling like a maze, and it is a fact about the route rather than a
 * decision for the page to make twice.
 */
export const questionBehindRoute = (route: OnboardingRouteId): 'who' | 'choose' =>
  route === 'agent' ? 'who' : 'choose';

/** The route an answer to the first question opens, when it opens one at all. */
export const doerRoute = (doer: OnboardingDoerId): OnboardingRouteId | undefined =>
  doer === 'agent' ? 'agent' : undefined;

/** Whether a value read back from storage or a link is still one of the routes we ship. */
export const isOnboardingRouteId = (value: unknown): value is OnboardingRouteId =>
  typeof value === 'string' && Object.hasOwn(ROUTES, value);

export type ConnectionMethodId = 'default-relay' | 'own-relay' | 'direct';

export interface ConnectionMethod {
  readonly id: ConnectionMethodId;
  readonly title: string;
  readonly answer: string;
  readonly recommended?: true;
}

const CONNECTIONS: Readonly<Record<ConnectionMethodId, ConnectionMethod>> = Object.freeze({
  'default-relay': Object.freeze({
    id: 'default-relay' as const,
    title: 'Use the default relay',
    answer: 'Recommended. Works from anywhere, with nothing for you to deploy.',
    recommended: true as const,
  }),
  'own-relay': Object.freeze({
    id: 'own-relay' as const,
    title: 'Set up my own relay',
    answer: 'Deploy a Cloudflare relay in your own account, step by step.',
  }),
  direct: Object.freeze({
    id: 'direct' as const,
    title: 'Direct connection',
    answer: 'Use the same network, a VPN, or any daemon host this browser can reach.',
  }),
});

export const CONNECTION_METHODS: readonly ConnectionMethod[] = Object.freeze([
  CONNECTIONS['default-relay'],
  CONNECTIONS['own-relay'],
  CONNECTIONS.direct,
]);

export const DEFAULT_CONNECTION_METHOD: ConnectionMethodId = 'default-relay';

export const connectionMethod = (id: ConnectionMethodId): ConnectionMethod => CONNECTIONS[id];

export const isConnectionMethodId = (value: unknown): value is ConnectionMethodId =>
  typeof value === 'string' && Object.hasOwn(CONNECTIONS, value);

/**
 * A route being walked BY A PARTICULAR DEVICE.
 *
 * The device is part of the path rather than a separate argument threaded through
 * nine helpers, because it is not an optional refinement: "first time setup" is a
 * genuinely different list of steps on a phone than on a computer, and a helper
 * that can be called without it would silently answer for the wrong one.
 */
export interface OnboardingPath {
  readonly route: OnboardingRouteId;
  readonly device: DeviceKind;
  /** The connection chooser's answer. Only the daemon-bearing routes have one. */
  readonly connection?: ConnectionMethodId | undefined;
}

/** The four extra stages a self-hosted relay costs, inserted where the choice was made. */
const OWN_RELAY_STEPS: readonly OnboardingStepId[] = Object.freeze([
  'relay-fingerprint',
  'relay-source',
  'relay-allow',
  'relay-deploy',
]);

/**
 * Standing up a daemon ON THIS MACHINE, and the collapse that makes it short.
 *
 * The browser reading this page is running on the machine that is about to host
 * the daemon — that is what the answer MEANT. So it is already a client of it,
 * over loopback, and there is no QR to scan and no code to type: `fy pair --open`
 * on the same machine opens this app already paired. Making somebody photograph
 * their own screen is the single most common first-run indignity, and it exists
 * only because the old arc could not tell the two machines apart.
 */
const daemonSteps = (connection: ConnectionMethodId | undefined): readonly OnboardingStepId[] =>
  Object.freeze([
    'install',
    'daemon',
    'connect',
    ...(connection === 'own-relay' ? OWN_RELAY_STEPS : []),
    'local',
  ] as OnboardingStepId[]);

/**
 * The steps this route walks on this device.
 *
 * FIRST TIME SETUP IS THE ONLY ROUTE THAT SPANS TWO DEVICES, and that is what
 * makes it more than the other two in sequence. On a computer it stands the
 * daemon up, pairs over loopback, and then OFFERS the phone. On a phone it cannot
 * begin — there is no terminal — so it hands the daemon half to a computer and
 * stays behind to finish pairing when that computer prints a code.
 *
 * `add-daemon` on a phone is one honest screen. It is not a route that pretends
 * to start; it says what is needed and sends the job somewhere it can happen.
 */
export const onboardingRouteSteps = ({ route, device, connection }: OnboardingPath): readonly OnboardingStepId[] => {
  /*
   * THE AGENT ROUTE IS THE SAME ON EVERY DEVICE, and that is the point of asking
   * who does the work first. The agent has the terminal, on the machine that
   * becomes the daemon; this browser only has to end up paired with it. So there
   * is no install to be impossible here, no platform to pick, and nothing about
   * this device left to decide — a phone walks exactly the journey a laptop does.
   */
  if (route === 'agent') return Object.freeze(['brief', 'agent-pair', 'done'] as OnboardingStepId[]);
  if (route === 'add-client') return Object.freeze(['pair', 'scan', 'done'] as OnboardingStepId[]);
  if (device === 'mobile') {
    return route === 'first-time'
      ? Object.freeze(['need-computer', 'scan', 'done'] as OnboardingStepId[])
      : Object.freeze(['need-computer'] as OnboardingStepId[]);
  }
  return Object.freeze([
    ...daemonSteps(connection),
    ...(route === 'first-time' ? (['handoff'] as OnboardingStepId[]) : []),
    'done',
  ] as OnboardingStepId[]);
};

/** Position within a route, or `-1` for a step that route never walks. */
export const onboardingStepIndex = (path: OnboardingPath, step: OnboardingStepId): number =>
  onboardingRouteSteps(path).indexOf(step);

/** Whether this step belongs to this route on this device — the guard every stored pair must pass. */
export const isStepOfRoute = (path: OnboardingPath, step: OnboardingStepId): boolean =>
  onboardingStepIndex(path, step) >= 0;

/** How many steps this route walks, for a track that has to say "step 2 of 5". */
export const onboardingStepCount = (path: OnboardingPath): number => onboardingRouteSteps(path).length;

/** The step a route opens on. */
export const firstOnboardingStep = (path: OnboardingPath): OnboardingStepId => {
  const [first] = onboardingRouteSteps(path);
  /* Unreachable: every branch above ships at least one step, and each list is frozen. */
  return first ?? 'done';
};

/** Is this a step the reader has been to, is on, or has not reached? */
export type OnboardingStepStatus = 'completed' | 'current' | 'upcoming';

/**
 * A step is jumpable exactly when the reader has already been there.
 *
 * `furthest` rather than `current` is what makes a back-jump reversible: after
 * stepping back from pairing to install, pairing is still somewhere the reader
 * has been, so the track must still take them there.
 */
export const onboardingStepStatus = (
  path: OnboardingPath,
  step: OnboardingStepId,
  current: OnboardingStepId,
  furthest: OnboardingStepId,
): OnboardingStepStatus => {
  if (step === current) return 'current';
  return onboardingStepIndex(path, step) <= onboardingStepIndex(path, furthest) ? 'completed' : 'upcoming';
};

/** The next step of this route, or the same one at the end of it. */
export const nextOnboardingStep = (path: OnboardingPath, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(path);
  return steps[Math.min(onboardingStepIndex(path, id) + 1, steps.length - 1)] ?? id;
};

/** The previous step of this route, or the same one at the start of it. */
export const previousOnboardingStep = (path: OnboardingPath, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(path);
  return steps[Math.max(onboardingStepIndex(path, id) - 1, 0)] ?? id;
};

/** The later of two steps of one route, so progress can only ever move forward. */
export const furthestOnboardingStep = (
  path: OnboardingPath,
  left: OnboardingStepId,
  right: OnboardingStepId,
): OnboardingStepId => (onboardingStepIndex(path, left) >= onboardingStepIndex(path, right) ? left : right);

/** Whether a value read back from storage is still one of the steps we ship. */
export const isOnboardingStepId = (value: unknown): value is OnboardingStepId =>
  typeof value === 'string' && Object.hasOwn(STEPS, value);

/**
 * Whether this step is the last one on its route, so nothing offers a way onward.
 *
 * `add-daemon` on a phone is a ONE-step route whose only screen is a refusal, and
 * a `Next` there would advance to itself — a control that does nothing is worse
 * than no control, because the reader presses it and concludes the page is stuck.
 */
export const isLastOnboardingStep = (path: OnboardingPath, step: OnboardingStepId): boolean =>
  onboardingStepIndex(path, step) === onboardingStepCount(path) - 1;

/**
 * Where a hand-off from THIS device should drop the other one.
 *
 * The asymmetry is the whole point. A phone cannot host a daemon, so it hands the
 * daemon half to a computer and asks it to start at the beginning of first-time
 * setup. A computer that already has a daemon has nothing to hand over except
 * membership, so it hands the phone the CLIENT route, at the step where somebody
 * must run `fy pair` — which, at that moment, is the computer doing the handing.
 */
export const handoffTarget = (
  path: OnboardingPath,
): { readonly route: OnboardingRouteId; readonly step: OnboardingStepId } =>
  path.device === 'mobile' ? { route: 'first-time', step: 'install' } : { route: 'add-client', step: 'pair' };
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
/** Prints the code and this daemon's fingerprint without staying to watch for the scan. */
export const PAIR_PRINT_COMMAND = 'fy pair --no-wait';
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

/**
 * A public, self-contained brief for an AI coding agent — THE PRODUCT of the
 * agent route, not a convenience beside it.
 *
 * The reader asked for a prompt they can paste into whatever agent already has a
 * terminal on the target machine. It therefore describes a STRANGER'S machine:
 * it names no host, no user, no daemon and no fleet, because this page is served
 * to anyone and this text is baked into the bundle. It also refuses to improvise
 * — an agent that cannot follow it must stop and report, since a half-installed
 * daemon is worse than an unstarted one.
 *
 * IT MUST SAY HOW TO REPORT BACK, or the person who pasted it is left wondering
 * whether anything worked. Which report depends on where they are reading this
 * page: on the daemon's own machine `fy pair --open` finishes the job outright,
 * and from a phone or another computer the QR and the link are the only way the
 * code can travel. The agent cannot know which, and guessing burns a single-use
 * code — so the prompt makes it ask, which is the one question the human can
 * always answer.
 */
export const AGENT_SETUP_PROMPT = [
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
  `4. Start the daemon: ${DAEMON_START_COMMAND}`,
  `5. Confirm it is running: ${DAEMON_STATUS_COMMAND} — it should print "${DAEMON_SERVING_OUTPUT}".`,
  '6. Ask me whether I am reading the Ferretry setup page in a browser ON THIS MACHINE, and pair the',
  '   way my answer requires. Do not guess: a pairing code is single-use, and the wrong one is spent.',
  `   - If I am on this machine: run ${PAIR_OPEN_COMMAND}. It opens Ferretry in this machine's browser,`,
  '     already paired, and there is nothing for me to type.',
  `   - If I am on a phone or another computer: run ${PAIR_COMMAND} and show me the QR code and the`,
  '     pairing link it prints, exactly as printed, so I can scan or paste it there.',
  '   The code is single-use and expires in about two minutes, so show it as soon as it appears.',
  '',
  'If any command fails, stop and report the exact command and the exact error. Do not improvise a',
  'workaround, do not install from an undocumented source, and do not edit configuration to route',
  'around a failure.',
].join('\n');

/** Indents a copyable block so the prompt stays readable as one pasted message. */
function toPromptLines(block: string): readonly string[] {
  return block.split('\n').map(line => `     ${line}`);
}

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
