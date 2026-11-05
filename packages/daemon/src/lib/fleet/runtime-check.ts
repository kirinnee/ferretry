/**
 * Checking a runtime: ONE real "reply OK" through it, on its own default model
 * (`POST /v1/fleet/runtimes/:runtimeId/check`, `@ferretry/protocol` `fleet-runtime-check.ts`).
 *
 * It is the start probe `fy new` already runs (`../pack/probe.ts`), through the same cache: the
 * runtime's own absolute launcher, its login's launch environment, 30 seconds at most. A pass is kept
 * there for the cache's own key — launcher, model and effort — so a start that asks for the same model
 * and effort inside the window is answered from it; a start that names an effort the check did not send
 * probes again. A failure is never kept.
 *
 * IT RUNS ONLY WHAT A START WOULD RUN. A runtime that is switched off (its own switch or its login's),
 * is not an agent runtime, or cannot launch right now (no CLI installed, its login needs signing in) is
 * refused before any process starts, with the catalogue's own reason — the same gates a start applies,
 * so the paid call is never spent on a runtime a start would refuse.
 *
 * IT RUNS IN A PRIVATE FOLDER. A CLI reads project files from its working directory (`CLAUDE.md`,
 * `.claude/settings.json`, `.mcp.json`, `AGENTS.md`), and it is started with the login's environment, so the
 * folder must be one nobody else can write to — never `/tmp`. The port that hands it out refuses a folder
 * that is a symlink, not ours, or not a directory, and the check then reports `not_launchable`.
 *
 * THE ANSWER NEVER CARRIES THE CLI'S OUTPUT. The probe reads output only to classify it, and this builds
 * the sentence from that CODE, where the probe stopped, and plain facts the daemon already holds: the
 * runtime's name, its model id, and its login's provider label, region, profile NAME and secret NAME.
 *
 * Pure: the runtime, its login's facts and the probe are ports.
 */
import { type Credential, type ProviderPreset, parseCloudCredential } from '@ferretry/fleet';
import {
  type FleetRuntimeCheckCode,
  type FleetRuntimeCheckRefusalCode,
  type FleetRuntimeCheckResult,
  secretReferencesIn,
} from '@ferretry/protocol';
import type { CachedProbe, PackProbeOutcome, PackProbeRequest } from '../pack/probe.ts';

/** How long one check may take: the same bound a start probe has. */
export const RUNTIME_CHECK_TIMEOUT_MS = 30_000;

/** The runtime a check runs, as the catalogue lists it. */
export interface RuntimeCheckTarget {
  readonly id: string;
  readonly name: string;
  readonly wrapper: string;
  readonly harness: 'claude' | 'codex';
  readonly credential: string;
  /** The model it starts on when nothing names one. Absent: the CLI's own default. */
  readonly defaultModel?: string;
  readonly disabled: boolean;
  /** Whether it is an agent runtime: only those can run a ferret, so only those are checked. */
  readonly agent: boolean;
  /** Why the catalogue says it cannot launch now ("Sign in to launch"); absent when it can. */
  readonly blocked?: string;
}

/**
 * What a sentence may say about the runtime's login: plain facts only. `provider` is a preset's label;
 * `region` a plain region; `profile` a cloud profile's NAME; `key` a secret's NAME.
 */
export interface RuntimeCheckLoginFacts {
  readonly provider?: string;
  readonly region?: string;
  readonly profile?: string;
  readonly key?: string;
}

export interface RuntimeCheckDeps {
  /** The runtime with this id, else with this name; `undefined` when there is none. */
  runtime(idOrName: string): Promise<RuntimeCheckTarget | undefined>;
  login(target: RuntimeCheckTarget): Promise<RuntimeCheckLoginFacts>;
  /** The start probe's cache: a pass is kept `ttlMs`, a failure never. */
  probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe>;
  /** How long a pass is kept: Pack mode's own setting, so a check and a start agree. */
  passTtlMs(): Promise<number>;
  /**
   * Where the probe runs: an empty folder only this daemon's account can write to. Throws when there is
   * none that is safe; the check then answers `not_launchable` rather than run somewhere else.
   */
  workingDirectory(): Promise<string>;
}

/** Why a check was not run. */
export class RuntimeCheckRefusal extends Error {
  constructor(
    readonly code: FleetRuntimeCheckRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeCheckRefusal';
  }
}

/** The failure code a probe's outcome is reported as: the probe's own classification first, then where it stopped. */
function checkCode(outcome: Extract<PackProbeOutcome, { ok: false }>): FleetRuntimeCheckCode {
  if (outcome.code !== undefined) return outcome.code;
  switch (outcome.stage) {
    case 'timeout':
      return 'timed_out';
    case 'launcher':
    case 'environment':
    case 'spawn':
      return 'not_launchable';
    default:
      return 'no_answer';
  }
}

const seconds = (ms: number): string => (Math.max(0, ms) / 1_000).toFixed(1);

/**
 * The one sentence a check answers with, from its code and plain facts — never from what the CLI said.
 */
export function checkSentence(
  target: Pick<RuntimeCheckTarget, 'name' | 'defaultModel'>,
  facts: RuntimeCheckLoginFacts,
  outcome: PackProbeOutcome,
): string {
  const { name } = target;
  const { provider, region, profile, key } = facts;
  const inRegion = region === undefined ? '' : ` in ${region}`;
  if (outcome.ok) {
    const via = provider === undefined ? '' : ` through ${provider}${region === undefined ? '' : ` (${region})`}`;
    return `${name} answered${via} in ${seconds(outcome.ms)} s.`;
  }
  const model = target.defaultModel === undefined ? 'the model' : `the model ${target.defaultModel}`;
  switch (checkCode(outcome)) {
    case 'model_unavailable':
      return provider === undefined
        ? `${name}'s login can't use ${model}.`
        : `${provider} refused ${model}${inRegion}.`;
    case 'not_logged_in':
      if (provider === undefined) return `${name} isn't signed in, or its sign-in was refused.`;
      if (profile !== undefined) return `${provider} refused profile ${profile}.`;
      if (key !== undefined) return `${provider} refused the key in ${key}.`;
      return `${provider} refused this login.`;
    case 'out_of_quota':
      return `${provider ?? `${name}'s login`} is out of quota or rate-limited.`;
    case 'timed_out':
      return `No answer in ${String(Math.round(RUNTIME_CHECK_TIMEOUT_MS / 1_000))} seconds.`;
    case 'not_launchable':
      if (outcome.stage === 'environment')
        return `Couldn't start ${name}: a secret or variable its login needs is missing.`;
      if (outcome.stage === 'spawn') return `Couldn't start ${name}: its CLI could not be run.`;
      return `Couldn't start ${name}: it isn't ready to launch on this machine.`;
    case 'no_answer':
      return outcome.stage === 'answer' ? `${name} answered, but not with OK.` : `${name} stopped without answering.`;
  }
}

/** Runs the check for one runtime. */
export class RuntimeCheckService {
  constructor(private readonly deps: RuntimeCheckDeps) {}

  async check(idOrName: string): Promise<FleetRuntimeCheckResult> {
    const target = await this.deps.runtime(idOrName);
    if (target === undefined) {
      throw new RuntimeCheckRefusal('fleet_runtime_unknown', `There is no runtime ${idOrName} on this machine.`);
    }
    if (target.disabled) {
      throw new RuntimeCheckRefusal(
        'fleet_runtime_disabled',
        `${target.name} is switched off, so it was not checked. Switch it on first.`,
      );
    }
    if (!target.agent) {
      throw new RuntimeCheckRefusal(
        'fleet_runtime_not_agent',
        `${target.name} is for using ${target.harness === 'claude' ? 'Claude Code' : 'Codex'} yourself in a terminal, so it cannot run a ferret and was not checked.`,
      );
    }
    if (target.blocked !== undefined) {
      throw new RuntimeCheckRefusal(
        'fleet_runtime_blocked',
        `${target.name} cannot start right now, so it was not checked: ${target.blocked}.`,
      );
    }
    const [facts, ttlMs] = await Promise.all([this.deps.login(target), this.deps.passTtlMs()]);
    const cwd = await this.deps.workingDirectory().then(
      folder => folder,
      () => undefined,
    );
    if (cwd === undefined) {
      return {
        ok: false,
        ms: 0,
        code: 'not_launchable',
        sentence: `Couldn't start ${target.name}: the private folder its check runs in isn't safe to use.`,
      };
    }
    const { outcome } = await this.deps.probe(
      {
        wrapper: target.wrapper,
        harness: target.harness,
        model: target.defaultModel,
        cwd,
        timeoutMs: RUNTIME_CHECK_TIMEOUT_MS,
      },
      ttlMs,
    );
    const ms = Math.max(0, Math.round(outcome.ms));
    const sentence = checkSentence(target, facts, outcome);
    return outcome.ok ? { ok: true, ms, sentence } : { ok: false, ms, code: checkCode(outcome), sentence };
  }
}

/** A region as plain text: short, and nothing like a key. */
const REGION = /^[a-z0-9][a-z0-9-]{1,40}$/u;

/**
 * The plain facts a check sentence may name about a login, read off its configuration: an environment
 * login's preset label, its `AWS_REGION` or `CLOUD_ML_REGION` when that is a plain region, its AWS
 * profile's NAME, and the NAME of the first secret it sends. A login kept in a sign-in has none.
 */
export function loginFacts(
  credential: Credential | undefined,
  harness: 'claude' | 'codex',
  presets: readonly Pick<ProviderPreset, 'id' | 'label'>[],
): RuntimeCheckLoginFacts {
  if (credential?.store !== 'environment') return {};
  const env: Record<string, string> = { ...credential.env, ...credential[harness]?.env };
  const provider = presets.find(preset => preset.id === credential.preset)?.label;
  const region = [env.AWS_REGION, env.CLOUD_ML_REGION].find(value => value !== undefined && REGION.test(value));
  const reference =
    credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
  const profile = reference?.kind === 'aws-profile' ? reference.profile : undefined;
  const key = Object.values(env).flatMap(value => secretReferencesIn(value))[0];
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(region === undefined ? {} : { region }),
    ...(profile === undefined ? {} : { profile }),
    ...(key === undefined ? {} : { key }),
  };
}
