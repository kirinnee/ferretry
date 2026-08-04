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
export type OnboardingStepId = 'install' | 'daemon' | 'connect' | 'brief' | 'pair' | 'done';

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
    title: 'Choose how to reach it',
    short: 'Reach',
    summary: 'How this browser gets to that daemon.',
  }),
  brief: Object.freeze({
    id: 'brief' as const,
    title: 'Brief your agent',
    short: 'Brief',
    summary: 'Paste this into an agent that has a terminal there.',
  }),
  pair: Object.freeze({
    id: 'pair' as const,
    title: 'Pair this device',
    short: 'Pair',
    summary: 'Scan the QR, or paste the link.',
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
    steps: Object.freeze(['pair', 'done'] as const),
  }),
  'first-time': Object.freeze({
    id: 'first-time' as const,
    title: 'First time setup',
    answer: 'Install, start the daemon, choose how to reach it, pair. Every new machine starts here.',
    steps: Object.freeze(['install', 'daemon', 'connect', 'pair', 'done'] as const),
  }),
  agent: Object.freeze({
    id: 'agent' as const,
    title: 'Let an agent set it up',
    answer: 'Copy a prompt for an agent that already has a terminal on that machine.',
    steps: Object.freeze(['brief', 'pair', 'done'] as const),
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
export const onboardingRouteSteps = (id: OnboardingRouteId): readonly OnboardingStepId[] => ROUTES[id].steps;

/** Position within a route, or `-1` for a step that route never walks. */
export const onboardingStepIndex = (route: OnboardingRouteId, step: OnboardingStepId): number =>
  onboardingRouteSteps(route).indexOf(step);

/** Whether this step belongs to this route at all — the guard every stored pair must pass. */
export const isStepOfRoute = (route: OnboardingRouteId, step: OnboardingStepId): boolean =>
  onboardingStepIndex(route, step) >= 0;

/** How many steps this route walks, for a track that has to say "step 2 of 5". */
export const onboardingStepCount = (route: OnboardingRouteId): number => onboardingRouteSteps(route).length;

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
): OnboardingStepStatus => {
  if (step === current) return 'current';
  return onboardingStepIndex(route, step) <= onboardingStepIndex(route, furthest) ? 'completed' : 'upcoming';
};

/** The next step of this route, or the same one at the end of it. */
export const nextOnboardingStep = (route: OnboardingRouteId, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(route);
  return steps[Math.min(onboardingStepIndex(route, id) + 1, steps.length - 1)] ?? id;
};

/** The previous step of this route, or the same one at the start of it. */
export const previousOnboardingStep = (route: OnboardingRouteId, id: OnboardingStepId): OnboardingStepId => {
  const steps = onboardingRouteSteps(route);
  return steps[Math.max(onboardingStepIndex(route, id) - 1, 0)] ?? id;
};

/** The later of two steps of one route, so progress can only ever move forward. */
export const furthestOnboardingStep = (
  route: OnboardingRouteId,
  left: OnboardingStepId,
  right: OnboardingStepId,
): OnboardingStepId => (onboardingStepIndex(route, left) >= onboardingStepIndex(route, right) ? left : right);

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

/* ---------- how a browser reaches a daemon, from docs/relay-protocol.md ---- */

export type ConnectionMethodId = 'direct' | 'own-relay' | 'own-protocol';

export interface ConnectionInstruction {
  /** What to do. A command may sit under it; text alone means "go and look". */
  readonly text: string;
  readonly command?: string;
  /** Names the block for its copy control. Required with a command, absurd without one. */
  readonly copyLabel?: string;
}

export interface ConnectionMethod {
  readonly id: ConnectionMethodId;
  /** Two or three words: three of these share a 390px row. */
  readonly label: string;
  /** When this is the right answer. */
  readonly answer: string;
  /** The steps THIS method needs. The whole point of the choice. */
  readonly instructions: readonly ConnectionInstruction[];
  /** Something true the reader would otherwise discover the hard way. Never a warning we invented. */
  readonly caveat?: string;
}

/**
 * WHY THERE IS NO DEFAULT RELAY ADDRESS.
 *
 * `docs/relay-protocol.md` §1 and §9: Ferretry ships no hosted relay and no
 * relay address compiled into anything. A single default would route every
 * user's traffic through one account, and because the carrier is end-to-end
 * encrypted that account could not police what it was carrying even in
 * principle. So the page offers a relay you DEPLOY, never a relay you are
 * silently already using.
 */
export const NO_DEFAULT_RELAY_NOTE =
  'Ferretry ships no relay address. There is no shared relay to fall back on: one default would carry ' +
  'everyone through a single account, and the traffic is encrypted end to end, so that account could ' +
  'not police what it carried.';

/**
 * The relay is deployable and tested; the two ends that speak it are not wired.
 *
 * `packages/relay/README.md` — "Status" — says so plainly, and repeating it here
 * is the difference between a page that documents a route and a page that
 * promises one. Somebody who deploys a relay today gets a working relay and a
 * daemon that does not yet dial it.
 */
export const RELAY_NOT_WIRED_CAVEAT =
  'The relay itself is complete and tested, but the daemon and browser ends that speak to it are separate ' +
  'work and are not wired up yet. Deploying one today gets you a relay, not yet a remote connection.';

const METHODS: Readonly<Record<ConnectionMethodId, ConnectionMethod>> = Object.freeze({
  direct: Object.freeze({
    id: 'direct' as const,
    label: 'Direct',
    answer: 'Same network, a VPN, or any host this browser can already reach. Fewest parties, nothing to deploy.',
    instructions: Object.freeze([
      Object.freeze({
        text: 'Nothing to deploy. Keep this browser and that machine on one network — same Wi-Fi, a VPN, or a host with a route to it.',
      }),
      Object.freeze({
        text: 'Check the daemon is still serving, then pair.',
        command: DAEMON_STATUS_COMMAND,
        copyLabel: 'Copy status command',
      }),
    ] as const),
  }),
  'own-relay': Object.freeze({
    id: 'own-relay' as const,
    label: 'Your own relay',
    answer: 'The daemon is behind NAT. Deploy the rendezvous Worker to your own Cloudflare account.',
    instructions: Object.freeze([
      Object.freeze({
        text: "Print this daemon's fingerprint. It is public — it is in the pairing QR.",
        command: PAIR_PRINT_COMMAND,
        copyLabel: 'Copy fingerprint command',
      }),
      Object.freeze({
        text: 'Get the relay source. It deploys from this repository.',
        command: 'git clone https://github.com/kirinnee/ferretry',
        copyLabel: 'Copy clone command',
      }),
      Object.freeze({
        text: 'Put that fingerprint in packages/relay/wrangler.jsonc under vars.RELAY_DAEMON_IDS. A relay carries the daemons its operator listed and nobody else, so an empty list serves nobody.',
      }),
      Object.freeze({
        text: 'Deploy it to your account. One command, and it bills to you.',
        command: 'task relay:deploy',
        copyLabel: 'Copy deploy command',
      }),
    ] as const),
    caveat: RELAY_NOT_WIRED_CAVEAT,
  }),
  'own-protocol': Object.freeze({
    id: 'own-protocol' as const,
    label: 'Your own build',
    answer: 'The wire contract is documented, so a relay can be implemented in any language, by anyone.',
    instructions: Object.freeze([
      Object.freeze({
        text: 'Implement docs/relay-protocol.md. It is the contract, written so it can be implemented without reading this repository.',
      }),
      Object.freeze({
        text: 'Read "Running your own relay" first. Sections 9 to 11 cover what a relay operator can and cannot see, and what you are taking on.',
      }),
    ] as const),
    caveat: RELAY_NOT_WIRED_CAVEAT,
  }),
});

export const CONNECTION_METHODS: readonly ConnectionMethod[] = Object.freeze([
  METHODS.direct,
  METHODS['own-relay'],
  METHODS['own-protocol'],
]);

/** Total, because the id is a closed union. */
export const connectionMethod = (id: ConnectionMethodId): ConnectionMethod => METHODS[id];

/**
 * Direct is what the page opens on.
 *
 * `docs/relay-protocol.md` §1: direct is preferred whenever it is configured and
 * reachable, and an implementation must not make somebody opt out of a relay to
 * get the simple thing. So the simple thing is the one already selected.
 */
export const DEFAULT_CONNECTION_METHOD: ConnectionMethodId = 'direct';

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
