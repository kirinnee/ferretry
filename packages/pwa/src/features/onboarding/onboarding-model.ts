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
 * THERE IS NO ONE ARC. Three different people open this page — somebody holding
 * a pairing link, somebody who has installed nothing, and somebody who would
 * rather an agent did it — and a single stepper with hidden steps serves none of
 * them. So a ROUTE is chosen first, and the route owns its own list of steps.
 */

/** Which of the three people opened the page. */
export type OnboardingRouteId = 'have-link' | 'first-time' | 'agent';

/** Every stage that any route can put on the glass, in no particular order. */
export type OnboardingStepId =
  | 'install'
  | 'daemon'
  | 'connect'
  | 'relay-fingerprint'
  | 'relay-source'
  | 'relay-allow'
  | 'relay-deploy'
  | 'brief'
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
  install: Object.freeze({
    id: 'install' as const,
    title: 'Install Ferretry',
    short: 'Install',
    summary: 'Run this on the machine your agents will work on.',
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
    summary: 'Choose how this browser will reach your machine.',
  }),
  'relay-fingerprint': Object.freeze({
    id: 'relay-fingerprint' as const,
    title: 'Get its fingerprint',
    short: 'Fingerprint',
    summary: 'On your computer, print the daemon identity your relay will allow.',
  }),
  'relay-source': Object.freeze({
    id: 'relay-source' as const,
    title: 'Get relay source',
    short: 'Source',
    summary: 'On your computer, get the deployment source.',
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
  brief: Object.freeze({
    id: 'brief' as const,
    title: 'Brief your agent',
    short: 'Brief',
    summary: 'Paste this into an agent that has a terminal there.',
  }),
  pair: Object.freeze({
    id: 'pair' as const,
    title: 'Run fy pair',
    short: 'Pair',
    summary: 'On your computer, print a fresh QR code and pairing link.',
  }),
  scan: Object.freeze({
    id: 'scan' as const,
    title: 'Scan QR or paste link',
    short: 'Scan',
    summary: 'On this phone or browser, use the fresh code from your computer.',
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
  /** The steps this route actually walks, in order. No hidden steps, no skipped ones. */
  readonly steps: readonly OnboardingStepId[];
}

/**
 * The three entry paths.
 *
 * Order is deliberate and is NOT "simplest first": somebody who already holds a
 * link is one tap from finished and should not read past their own answer, and
 * everybody arriving from a QR is in exactly that position.
 */
const ROUTES: Readonly<Record<OnboardingRouteId, OnboardingRoute>> = Object.freeze({
  'have-link': Object.freeze({
    id: 'have-link' as const,
    title: 'I have a link or QR',
    answer: 'Scan or paste it. Nothing to install, nothing to start.',
    steps: Object.freeze(['scan', 'done'] as const),
  }),
  'first-time': Object.freeze({
    id: 'first-time' as const,
    title: 'First time setup',
    answer: 'Install, start the daemon, choose a connection, then pair this browser. Every new machine starts here.',
    steps: Object.freeze(['install', 'daemon', 'connect', 'pair', 'scan', 'done'] as const),
  }),
  agent: Object.freeze({
    id: 'agent' as const,
    title: 'Let an agent set it up',
    answer: 'Copy a prompt for an agent that already has a terminal on that machine.',
    steps: Object.freeze(['brief', 'pair', 'scan', 'done'] as const),
  }),
});

export const ONBOARDING_ROUTES: readonly OnboardingRoute[] = Object.freeze([
  ROUTES['have-link'],
  ROUTES['first-time'],
  ROUTES.agent,
]);

/** Total, because the id is a closed union. */
export const onboardingRoute = (id: OnboardingRouteId): OnboardingRoute => ROUTES[id];

/** Whether a value read back from storage is still one of the routes we ship. */
export const isOnboardingRouteId = (value: unknown): value is OnboardingRouteId =>
  typeof value === 'string' && ONBOARDING_ROUTES.some(route => route.id === value);

/** The steps of one route. */
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
  typeof value === 'string' && CONNECTION_METHODS.some(method => method.id === value);

const SELF_HOSTED_RELAY_STEPS: readonly OnboardingStepId[] = Object.freeze([
  'install',
  'daemon',
  'connect',
  'relay-fingerprint',
  'relay-source',
  'relay-allow',
  'relay-deploy',
  'pair',
  'scan',
  'done',
]);

/** The self-host path alone grows: its extra work is visible on the track. */
export const onboardingRouteSteps = (
  id: OnboardingRouteId,
  connection?: ConnectionMethodId,
): readonly OnboardingStepId[] =>
  id === 'first-time' && connection === 'own-relay' ? SELF_HOSTED_RELAY_STEPS : ROUTES[id].steps;

/** Position within a route, or `-1` for a step that route never walks. */
export const onboardingStepIndex = (
  route: OnboardingRouteId,
  step: OnboardingStepId,
  connection?: ConnectionMethodId,
): number => onboardingRouteSteps(route, connection).indexOf(step);

/** Whether this step belongs to this route at all — the guard every stored pair must pass. */
export const isStepOfRoute = (
  route: OnboardingRouteId,
  step: OnboardingStepId,
  connection?: ConnectionMethodId,
): boolean => onboardingStepIndex(route, step, connection) >= 0;

/** How many steps this route walks, for a track that has to say "step 2 of 5". */
export const onboardingStepCount = (route: OnboardingRouteId, connection?: ConnectionMethodId): number =>
  onboardingRouteSteps(route, connection).length;

/** The step a route opens on. */
export const firstOnboardingStep = (route: OnboardingRouteId): OnboardingStepId => {
  const [first] = onboardingRouteSteps(route);
  /* Unreachable: every route above ships at least two steps, and the list is frozen. */
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
  route: OnboardingRouteId,
  step: OnboardingStepId,
  current: OnboardingStepId,
  furthest: OnboardingStepId,
  connection?: ConnectionMethodId,
): OnboardingStepStatus => {
  if (step === current) return 'current';
  return onboardingStepIndex(route, step, connection) <= onboardingStepIndex(route, furthest, connection)
    ? 'completed'
    : 'upcoming';
};

/** The next step of this route, or the same one at the end of it. */
export const nextOnboardingStep = (
  route: OnboardingRouteId,
  id: OnboardingStepId,
  connection?: ConnectionMethodId,
): OnboardingStepId => {
  const steps = onboardingRouteSteps(route, connection);
  return steps[Math.min(onboardingStepIndex(route, id, connection) + 1, steps.length - 1)] ?? id;
};

/** The previous step of this route, or the same one at the start of it. */
export const previousOnboardingStep = (
  route: OnboardingRouteId,
  id: OnboardingStepId,
  connection?: ConnectionMethodId,
): OnboardingStepId => {
  const steps = onboardingRouteSteps(route, connection);
  return steps[Math.max(onboardingStepIndex(route, id, connection) - 1, 0)] ?? id;
};

/** The later of two steps of one route, so progress can only ever move forward. */
export const furthestOnboardingStep = (
  route: OnboardingRouteId,
  left: OnboardingStepId,
  right: OnboardingStepId,
  connection?: ConnectionMethodId,
): OnboardingStepId =>
  onboardingStepIndex(route, left, connection) >= onboardingStepIndex(route, right, connection) ? left : right;

/** Whether a value read back from storage is still one of the steps we ship. */
export const isOnboardingStepId = (value: unknown): value is OnboardingStepId =>
  typeof value === 'string' && Object.hasOwn(STEPS, value);

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
/** What a serving daemon prints, so the reader knows what they are looking for. */
export const DAEMON_SERVING_OUTPUT = 'fyd is serving';

/**
 * A public, self-contained brief for an AI coding agent.
 *
 * The reader asked for a prompt they can paste into whatever agent already has a
 * terminal on the target machine. It therefore describes a STRANGER'S machine:
 * it names no host, no user, no daemon and no fleet, because this page is served
 * to anyone and this text is baked into the bundle. It also refuses to improvise
 * — an agent that cannot follow it must stop and report, since a half-installed
 * daemon is worse than an unstarted one.
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
  `6. Run ${PAIR_COMMAND} and show me the QR code and the pairing link it prints, exactly as printed.`,
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
