/**
 * Everything the first-run stepper KNOWS, with nothing it renders.
 *
 * The page is public and static: it cannot see the reader's terminal, so it can
 * never verify that a command worked. That single fact shapes this module —
 * every string here is either taken verbatim from `INSTALLATION.md` and the
 * mounted CLI commands, or it is an honest instruction to go and look. Nothing
 * is invented, and nothing claims a check that did not happen.
 *
 * The commands live here rather than in the components because they are the
 * part that must not drift: the same block is displayed, copied, and pasted
 * into the agent prompt, so there is exactly one copy of each.
 */

/** The four stages of the arc, in order. */
export type OnboardingStepId = 'install' | 'daemon' | 'pair' | 'done';

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  /** The step heading. */
  readonly title: string;
  /** The track label. One word, because four of them share a 390px row. */
  readonly short: string;
  /**
   * One short line under the heading.
   *
   * Never a paragraph, and now never a sentence either: the diagram beside it
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
  pair: Object.freeze({
    id: 'pair' as const,
    title: 'Pair this device',
    short: 'Pair',
    summary: 'Link this browser to that daemon.',
  }),
  done: Object.freeze({
    id: 'done' as const,
    title: 'You are set up',
    short: 'Done',
    summary: 'This browser is a window onto your machine.',
  }),
});

export const ONBOARDING_STEPS: readonly OnboardingStep[] = Object.freeze([
  STEPS.install,
  STEPS.daemon,
  STEPS.pair,
  STEPS.done,
]);

/** Total, because the id is a closed union. */
export const onboardingStep = (id: OnboardingStepId): OnboardingStep => STEPS[id];

/** Position in the arc; `-1` never escapes this module because the ids are a closed union. */
const stepIndex = (id: OnboardingStepId): number => ONBOARDING_STEPS.findIndex(step => step.id === id);

/** Position in the arc, for a track that has to say "step 2 of 4". */
export const onboardingStepIndex = (id: OnboardingStepId): number => stepIndex(id);

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

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
  step: OnboardingStepId,
  current: OnboardingStepId,
  furthest: OnboardingStepId,
): OnboardingStepStatus => {
  if (step === current) return 'current';
  return stepIndex(step) <= stepIndex(furthest) ? 'completed' : 'upcoming';
};

/** The next step, or the same one at the end of the arc. */
export const nextOnboardingStep = (id: OnboardingStepId): OnboardingStepId =>
  ONBOARDING_STEPS[Math.min(stepIndex(id) + 1, ONBOARDING_STEP_COUNT - 1)]?.id ?? id;

/** The previous step, or the same one at the start of the arc. */
export const previousOnboardingStep = (id: OnboardingStepId): OnboardingStepId =>
  ONBOARDING_STEPS[Math.max(stepIndex(id) - 1, 0)]?.id ?? id;

/** The later of two steps, so progress can only ever move forward. */
export const furthestOnboardingStep = (left: OnboardingStepId, right: OnboardingStepId): OnboardingStepId =>
  stepIndex(left) >= stepIndex(right) ? left : right;

/** Whether a value read back from storage is still one of the steps we ship. */
export const isOnboardingStepId = (value: unknown): value is OnboardingStepId =>
  typeof value === 'string' && ONBOARDING_STEPS.some(step => step.id === value);

/* ---------- install channels, verbatim from INSTALLATION.md ---------------- */

export type InstallChannelId = 'apt' | 'dnf' | 'brew' | 'curl';

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
}

/**
 * The four documented install routes.
 *
 * Copied character for character out of `INSTALLATION.md`, which
 * `scripts/validate/cli-contracts.sh` pins — a paraphrase here would be a
 * command that has never been tested. macOS is arm64-only upstream, so no
 * Intel option is offered.
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
  curl: Object.freeze({
    id: 'curl' as const,
    label: 'Linux / macOS',
    command:
      'curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash',
  }),
});

/** Every documented route, in switcher order. */
export const INSTALL_CHANNELS: readonly InstallChannel[] = Object.freeze([
  CHANNELS.apt,
  CHANNELS.dnf,
  CHANNELS.brew,
  CHANNELS.curl,
]);

/** Total, because the id is a closed union — an unknown channel cannot be constructed. */
export const installChannel = (id: InstallChannelId): InstallChannel => CHANNELS[id];

/** Proves the install landed. */
export const VERIFY_COMMAND = 'fy --version';
/** Starts the daemon and waits until it serves. */
export const DAEMON_START_COMMAND = 'fy daemon start';
/** The one honest liveness answer: it probes the daemon's health endpoint. */
export const DAEMON_STATUS_COMMAND = 'fy daemon status';
/** Mints the single-use code this browser redeems. */
export const PAIR_COMMAND = 'fy pair';
/** What a serving daemon prints, so the reader knows what they are looking for. */
export const DAEMON_SERVING_OUTPUT = 'fyd is serving';

/**
 * The install route to show first, guessed from the user agent.
 *
 * A guess, not a claim — every other route stays one tap away, because the
 * machine being set up is frequently NOT the one holding this page: a phone
 * that scanned the QR is pointing at a laptop. Phones therefore resolve to the
 * route most likely to work on the machine they are standing next to: an
 * iPhone's owner is probably at a Mac, an Android's owner probably at Linux.
 * Anything unrecognised gets the one-line installer, which is the only route
 * that works on every supported target.
 */
export const detectInstallChannel = (userAgent: string | undefined): InstallChannelId => {
  const agent = (userAgent ?? '').toLowerCase();
  if (agent.includes('mac') || agent.includes('iphone') || agent.includes('ipad')) return 'brew';
  if (agent.includes('ubuntu') || agent.includes('debian')) return 'apt';
  if (agent.includes('fedora') || agent.includes('red hat') || agent.includes('centos')) return 'dnf';
  return 'curl';
};

/**
 * A public, self-contained brief for an AI coding agent.
 *
 * The reader asked for a prompt they can paste into whatever agent already has
 * a terminal on the target machine. It therefore describes a STRANGER'S
 * machine: it names no host, no user, no daemon and no fleet, because this page
 * is served to anyone and this text is baked into the bundle. It also refuses
 * to improvise — an agent that cannot follow it must stop and report, since a
 * half-installed daemon is worse than an unstarted one.
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
