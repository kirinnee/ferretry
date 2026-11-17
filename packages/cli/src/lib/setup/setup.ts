/**
 * `fy setup` (V-0436, owner !A525 O7): v4's one command that finishes an install. In order: install the daemon as a
 * user service, wait until it answers `/healthz`, show the pairing QR for a phone (at a terminal), then run the first
 * run (`fy onboard`). The order is the whole design: nothing is asked or paired against a daemon that is not serving.
 *
 * Pure orchestration over four steps handed in as a port, so the order and the refusals are tested without a daemon, a
 * terminal or a service manager. The shell handler (`commands/setup.ts`) binds each step to the verb that does it.
 */
import { EXIT } from '../errors.ts';

/** What `fy setup` was asked for. */
export interface SetupOptions {
  readonly yes: boolean;
  readonly check: boolean;
  readonly json: boolean;
}

/** Whether the daemon answered `/healthz`, and where. */
export type SetupHealth =
  | { readonly up: true; readonly baseUrl: string }
  | { readonly up: false; readonly baseUrl: string; readonly why: string };

/** The four things setup does, each one an existing verb. */
export interface SetupSteps {
  /** Standard input and output are a terminal: a QR can be drawn and a question asked. */
  readonly interactive: boolean;
  /** `fy daemon install`: the exit code is the verb's, and the verb has already said why on a failure. */
  install(): Promise<number>;
  /** One look at `/healthz`, waiting a little for a daemon still coming up. Never starts anything. */
  health(): Promise<SetupHealth>;
  /** Access's `pair` verb, asked to print the code and not stay for the scan. */
  pair(): Promise<number>;
  /** `fy onboard`, with the switches the person gave. */
  onboard(flags: readonly string[]): Promise<number>;
  /** A progress line: on the output stream, or on the error stream under `--json` (stdout then carries only `onboard`'s JSON). */
  say(line: string): void;
  /** A refusal or a failure, on the error stream. */
  complain(line: string): void;
}

/** The switches `fy onboard` is handed: the ones setup shares with it. */
const onboardFlags = (options: SetupOptions): readonly string[] => [
  ...(options.yes ? ['--yes'] : []),
  ...(options.check ? ['--check'] : []),
  ...(options.json ? ['--json'] : []),
];

/**
 * Runs setup. Returns the exit code: `onboard`'s when everything before it worked, the failing step's otherwise.
 * `--check` changes nothing: it says whether the daemon answers and, only if it does, asks `onboard --check` what is
 * present (asking the daemon anything while it is down would start it).
 */
export async function runSetup(options: SetupOptions, steps: SetupSteps, binary: string): Promise<number> {
  if (options.check) return await check(options, steps, binary);

  // Refused BEFORE anything is installed: `onboard` asks its questions on a terminal, and a half-run setup that stops
  // at the first question is worse than one that says so up front.
  if (!steps.interactive && !options.yes) {
    steps.complain(
      `${binary} setup asks questions, so it needs a terminal; run it in one, or pass --yes to go ahead without asking`,
    );
    return EXIT.usage;
  }

  steps.say('1/4 install the daemon as a user service');
  const installed = await steps.install();
  if (installed !== 0) {
    steps.complain(
      `${binary} setup stopped: the daemon service did not install; fix that, then run ${binary} setup again`,
    );
    return installed;
  }

  steps.say('2/4 wait for the daemon to answer');
  const health = await steps.health();
  if (!health.up) {
    steps.complain(
      `${binary} setup stopped: the daemon did not answer at ${health.baseUrl} (${health.why}); \`${binary} daemon logs\` says why, then run ${binary} setup again`,
    );
    return EXIT.failure;
  }
  steps.say(`the daemon is serving at ${health.baseUrl}`);

  let paired = 0;
  // INSTALLATION.md: `--yes` is the unattended run and shows no QR; `--json` is read by a program, which cannot scan one.
  if (steps.interactive && !options.yes && !options.json) {
    steps.say('3/4 pair a phone or another device');
    paired = await steps.pair();
    if (paired !== 0)
      steps.complain(`the pairing code could not be shown; pair a device later with \`${binary} pair\``);
  } else {
    steps.say(
      `3/4 pair a phone or another device: not here (no QR without a terminal, or with --yes or --json); run \`${binary} pair\` at one`,
    );
  }

  steps.say('4/4 first run');
  const onboarded = await steps.onboard(onboardFlags(options));
  return onboarded !== 0 ? onboarded : paired;
}

async function check(options: SetupOptions, steps: SetupSteps, binary: string): Promise<number> {
  const health = await steps.health();
  if (!health.up) {
    steps.say(
      `the daemon is not answering at ${health.baseUrl} (${health.why}); ${binary} setup would install it as a user service, wait for it, offer the pairing QR, then run the first run`,
    );
    return EXIT.failure;
  }
  steps.say(`the daemon is serving at ${health.baseUrl}`);
  return await steps.onboard(onboardFlags(options));
}
