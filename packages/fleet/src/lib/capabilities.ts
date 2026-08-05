/**
 * What the configuration asks for that this build does not do.
 *
 * The schema in `config.ts` is the whole of the tool this replaces: it accepts `sharedHistory`,
 * `health` and every `usage` knob because a migrating operator's file has them. Accepting a key is
 * not the same as honouring it, and the difference used to be invisible — a fleet could be told to
 * pool its sessions across accounts, apply cleanly, and pool nothing, with no line of output saying
 * so. A fleet that believes its transcripts are shared, or that something is watching its quota,
 * when neither is true, is worse off than one that is refused and told which key is not implemented.
 *
 * So this module is the list, and {@link unimplementedCapabilities} is the check `fy fleet apply`
 * makes before it plans anything.
 *
 * **It fires only on a value an operator had to write.** Every entry compares against the schema's
 * own default, so a configuration that merely carries the defaults — which is every configuration
 * that never mentions these sections — applies exactly as before. `usage.enabled` defaults to true
 * and is therefore not a request; `usage.cliProxy` defaults to empty and one entry in it is.
 *
 * Pure: a configuration in, a list of refusals out. Removing an entry from {@link CAPABILITY_CHECKS}
 * is how a future unit records that it implemented one.
 */
import type { FleetConfig } from './config.ts';

/** One thing the configuration asked for, and what its absence means for the fleet. */
export interface UnimplementedCapability {
  /** Dotted path of the offending key, as an operator would find it in their file. */
  readonly key: string;
  /** What would happen if the key were honoured. */
  readonly capability: string;
  /** What the fleet silently does instead. Stated because it is the part that misleads. */
  readonly consequence: string;
}

interface CapabilityCheck {
  readonly key: string;
  readonly capability: string;
  readonly consequence: string;
  /** True when the configuration is *asking* for this, rather than carrying a default. */
  readonly requested: (config: FleetConfig) => boolean;
}

/** The schema default this check compares against; a mismatch here would silently disarm it. */
const USAGE_JITTER_DEFAULT = 0.25;

/**
 * Every capability the schema can express and this build cannot perform.
 *
 * Kept as data rather than a chain of conditionals so the survey row, the refusal message and the
 * check are one statement. The fleet survey under `docs/migration/surveys/` names the source of each.
 */
const CAPABILITY_CHECKS: readonly CapabilityCheck[] = [
  {
    key: 'sharedHistory.claude',
    capability: 'pooling every Claude account’s session state so any account can resume any session',
    consequence: 'each account keeps its own transcripts, and no session is resumable from another account',
    requested: config => config.sharedHistory.claude,
  },
  {
    key: 'sharedHistory.codex',
    capability: 'pooling every Codex account’s rollouts and shared SQLite runtime state',
    consequence: 'each account keeps its own rollouts, and no thread is resumable from another account',
    requested: config => config.sharedHistory.codex,
  },
  {
    key: 'usage.cliProxy',
    capability: 'reading runtime availability from a local CLIProxyAPI pool',
    consequence: 'the accounts that pool serves report as ordinary accounts, so a pool in cooldown looks usable',
    requested: config => config.usage.cliProxy.length > 0,
  },
  {
    key: 'health.enabled',
    capability: 'probing each account with a real model call to prove it can complete a turn',
    consequence: 'nothing verifies an account beyond that its wrapper exists, so a broken account reads as fine',
    requested: config => config.health.enabled,
  },
  // `usage.interval` is NOT here any more. It is implemented: the daemon's cached usage feed
  // collects through this library and serves one snapshot for exactly that many seconds before
  // re-collecting, which is what re-probing on a schedule means. It stays the only name for that
  // cadence — the daemon's own configuration used to carry a second one.
  {
    key: 'usage.jitter',
    capability: 'spreading a fleet’s background probes so they do not synchronize',
    consequence:
      'the daemon re-collects when a snapshot has aged past usage.interval rather than on a timer, so there is no synchronized cycle to spread',
    requested: config => config.usage.jitter !== USAGE_JITTER_DEFAULT,
  },
];

/**
 * Everything this configuration asks for that the build cannot do, in declaration order.
 *
 * An empty list is the normal answer. A non-empty one is a refusal, not a warning: see
 * {@link UnimplementedFleetCapabilityError}.
 */
export function unimplementedCapabilities(config: FleetConfig): readonly UnimplementedCapability[] {
  return CAPABILITY_CHECKS.filter(check => check.requested(config)).map(check => ({
    key: check.key,
    capability: check.capability,
    consequence: check.consequence,
  }));
}

/**
 * Raised when a configuration asks for a capability this build does not have.
 *
 * The message names every offending key at once — an operator fixing them one refusal at a time
 * would run `apply` five times to learn five things — and each line says what would have happened
 * and what happens instead, because "not implemented" alone leaves the reader where they were.
 */
export class UnimplementedFleetCapabilityError extends Error {
  constructor(readonly capabilities: readonly UnimplementedCapability[]) {
    super(
      [
        `the fleet configuration asks for ${capabilities.length === 1 ? 'a capability' : 'capabilities'} this build does not implement:`,
        ...capabilities.map(item => `  ${item.key} — ${item.capability}; without it, ${item.consequence}`),
        'Remove or disable the listed keys to apply. They are refused rather than ignored so a fleet is never told it has something it does not.',
      ].join('\n'),
    );
    this.name = 'UnimplementedFleetCapabilityError';
  }
}
