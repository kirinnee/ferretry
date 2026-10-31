import { detectProvider } from '@ferretry/fleet';
import type { FleetProviderPresetView } from '@ferretry/protocol';
import type { Command } from 'commander';
import { requireMayApply } from '../fleet/account-authority.ts';
import { runChange } from '../fleet/account-change.ts';
import { parseHarness, readOptions, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError, type AccountHarness } from '../fleet/account-ports.ts';
import { HARNESS_LABEL } from '../fleet/account-render.ts';
import { parseReason, parseUntil } from '../fleet/disable-until.ts';
import { runSignIn } from '../fleet/sign-in.ts';
import { definedEnv, detectionSentence, detectionTable } from './detect-env.ts';
import {
  presetDefaultEnv,
  presetRequiredPlainGaps,
  presetSecretsNeeded,
  secretFromShell,
  withShellPlainValues,
} from './provider-env.ts';
import {
  matchPresetWord,
  offeredHarnesses,
  presetDriveSentence,
  presetOfferedRefusal,
  resolveAddHarness,
} from './provider-match.ts';
import { registerBudgetCommand } from './budget.ts';
import { renderCredentialList, renderCredentialRow, renderPresetList } from './render.ts';

const CREDENTIAL_ID_LIMIT = 64;

/** A credential id from a label: lowercase letters, digits and dashes. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/**
 * The id a new login gets when nobody names one: `<harness>-<label>`, or `<harness>-login`, with `-2`,
 * `-3`… added until it is free.
 */
export function suggestCredentialId(
  harness: AccountHarness,
  label: string | undefined,
  taken: ReadonlySet<string>,
): string {
  const base = `${harness}-${slug(label ?? '') || 'login'}`.slice(0, CREDENTIAL_ID_LIMIT - 3);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Mounts `credentials` and `credential …` (docs/design/account-model.md §6.2). */
export function registerCredentialCommands(program: Command, deps: AccountCommandDeps): void {
  const bin = deps.binaryName;

  readOptions(
    program
      .command('credentials')
      .alias('logins')
      .description('the logins on this machine, with their status and usage'),
  ).action(async (options: { json?: boolean }) => {
    const list = await deps.gateway.credentials();
    deps.out.report(options.json ? JSON.stringify(list, null, 2) : renderCredentialList(list, bin));
  });

  // `login` is the product's word for a credential (docs/config-files.md: `logins/<id>.yaml`).
  const credential = program
    .command('credential')
    .alias('login')
    .description('add, check, sign in, sign out, label, disable, budget or remove a login');

  writeOptions(
    credential
      .command('add')
      .description('add a login: sign claude or codex in, or build one from a provider preset')
      .argument('[tool-or-provider]', 'claude, codex, or a provider — e.g. glm, deepseek, bedrock')
      .option('--label <label>', 'a name to tell this login apart from another with the same email')
      .option('--id <id>', 'the id to give it (default: made from the tool and the label)')
      .option('--no-sign-in', 'add the login without signing in now')
      .option('--preset <id>', `an environment login from a provider preset (see \`${bin} login presets\`)`)
      .option(
        '--env <NAME=VALUE>',
        'an environment login variable: a plain value, or ${secret:NAME} for a secret (repeat it)',
        collectEnv,
        {},
      )
      .option('--cloud-credential <reference>', 'aws-profile:<name>, gcloud-adc[:<path>] or azure-cli')
      .option('--for <tool>', 'which CLI a provider that drives both is listed under first (claude or codex)')
      .option('--from-env', 'import from the variables already set in this shell, instead of typing one')
      .option('--test', 'test the login once it is added, the same as `login test`'),
  ).action(
    async (
      tool: string | undefined,
      options: {
        label?: string;
        id?: string;
        signIn?: boolean;
        preset?: string;
        env?: Record<string, string>;
        cloudCredential?: string;
        for?: string;
        fromEnv?: boolean;
        test?: boolean;
      } & Record<string, unknown>,
    ) => {
      const word = tool?.trim();
      if (options.fromEnv !== true && (word?.toLowerCase() === 'claude' || word?.toLowerCase() === 'codex')) {
        await addToolLogin(deps, word as string, options);
        return;
      }
      await addProviderLogin(deps, word === '' ? undefined : word, options);
    },
  );

  readOptions(
    credential
      .command('check')
      .description('check now whether a login still works (a refresh for Codex)')
      .argument('<id>', 'the login'),
  ).action(async (id: string, options: { json?: boolean }) => {
    await requireMayApply(deps);
    const view = await deps.gateway.check(id);
    deps.out.report(options.json ? JSON.stringify(view, null, 2) : renderCredentialRow(view, bin).join('\n'));
    if (view.status.word === 'needs_sign_in') {
      if (!options.json) deps.out.error(`${id} needs sign-in: ${bin} credential signin ${id}`);
      deps.out.setExitCode(1);
    }
  });

  registerBudgetCommand(credential, deps);

  readOptions(
    credential
      .command('test')
      .description('test an environment login with one request, the cheapest its provider allows')
      .argument('<id>', 'the login')
      .option('--allow-inference', 'agree to one message capped at one token, for a provider with no free check'),
  ).action(async (id: string, options: { json?: boolean; allowInference?: boolean }) => {
    await requireMayApply(deps);
    const result = await deps.gateway.test(id, options.allowInference === true);
    deps.out.report(options.json ? JSON.stringify(result, null, 2) : `${id}: ${result.message}`);
    if (result.code === 'consent_required' && !options.json) {
      deps.out.error(`To send it: ${bin} login test ${id} --allow-inference`);
    }
    if (!result.ok) deps.out.setExitCode(1);
  });

  readOptions(
    credential.command('presets').description('the provider presets an environment login can be made from'),
  ).action(async (options: { json?: boolean }) => {
    const catalog = await deps.gateway.presets();
    deps.out.report(options.json ? JSON.stringify(catalog, null, 2) : renderPresetList(catalog, bin));
  });

  credential
    .command('signin')
    .description('sign a login in, or in again')
    .argument('<id>', 'the login')
    .option(
      '--force',
      'start over: end the sign-in already running for it, and clear a leftover Codex sign-in from its port',
    )
    .action(async (id: string, options: { force?: boolean }) => {
      await runSignIn(deps, id, { force: options.force === true });
    });

  writeOptions(
    credential
      .command('signout')
      .description('sign a login out; every runtime on it then needs sign-in')
      .argument('<id>', 'the login'),
  ).action(async (id: string, options: Record<string, unknown>) => {
    await runChange(deps, {
      change: { kind: 'credential.signout', id },
      destructive: true,
      options: writeFlags(options),
    });
  });

  writeOptions(
    credential
      .command('disable')
      .description('switch a login off without deleting it: nothing new starts on it; running ferrets keep going')
      .argument('<id>', 'the login')
      .option('--until <when>', 'switch back on by itself: a date (2026-11-01), a time or a wait (3d, 12h)')
      .option('--reason <text>', 'why, shown beside the switch and in every refusal'),
  ).action(async (id: string, options: { until?: string; reason?: string } & Record<string, unknown>) => {
    const reason = parseReason(options.reason);
    await runChange(deps, {
      change: {
        kind: 'credential.disable',
        id,
        ...(reason === undefined ? {} : { reason }),
        ...(options.until === undefined ? {} : { until: parseUntil(options.until, deps.now()) }),
      },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    credential.command('enable').description('switch a disabled login back on').argument('<id>', 'the login'),
  ).action(async (id: string, options: Record<string, unknown>) => {
    await runChange(deps, {
      change: { kind: 'credential.enable', id },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    credential
      .command('label')
      .description('give a login a label, or take it away with --clear')
      .argument('<id>', 'the login')
      .argument('[label]', 'the label')
      .option('--clear', 'remove the label'),
  ).action(async (id: string, label: string | undefined, options: { clear?: boolean } & Record<string, unknown>) => {
    if (options.clear !== true && (label === undefined || label.trim() === '')) {
      throw new AccountCommandError(`Name the label, or pass --clear: ${bin} credential label ${id} work`);
    }
    await runChange(deps, {
      change: { kind: 'credential.label', id, label: options.clear === true ? null : (label as string).trim() },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    credential
      .command('rm')
      .alias('remove')
      .description('remove a login (refused while a runtime uses it)')
      .argument('<id>', 'the login'),
  ).action(async (id: string, options: Record<string, unknown>) => {
    await runChange(deps, {
      change: { kind: 'credential.remove', id },
      destructive: true,
      options: writeFlags(options),
    });
  });
}

/**
 * `fy login add claude|codex` (docs/provider-presets.md §1): sign-in, or an environment login from an
 * explicit `--preset`/`--env`/`--cloud-credential` — exactly as before one-click providers existed.
 */
async function addToolLogin(
  deps: AccountCommandDeps,
  tool: string,
  options: {
    readonly label?: string;
    readonly id?: string;
    readonly signIn?: boolean;
    readonly preset?: string;
    readonly env?: Record<string, string>;
    readonly cloudCredential?: string;
  } & Record<string, unknown>,
): Promise<void> {
  const bin = deps.binaryName;
  const harness = parseHarness(tool);
  const taken = new Set((await deps.gateway.credentials()).credentials.map(entry => entry.id));
  const id = options.id ?? suggestCredentialId(harness, options.label ?? options.preset, taken);
  const flags = writeFlags(options);
  const environment = await environmentLogin(deps, harness, options);
  const outcome = await runChange(deps, {
    change: {
      kind: 'credential.add',
      id,
      harness,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...environment,
    },
    destructive: false,
    options: flags,
  });
  if (outcome === undefined || flags.json) return;
  if (environment.store === 'environment') {
    deps.out.report(`Store each secret it names with \`${bin} secret set NAME\`, then: ${bin} login test ${id}`);
    return;
  }
  if (options.signIn === false) {
    deps.out.report(`Sign it in when you are ready: ${bin} credential signin ${id}`);
    return;
  }
  await runSignIn(deps, id);
}

/**
 * The preset `fy login add <provider>` and its `--from-env`/bare-`--env` detection names
 * (docs/provider-presets.md §2–4): the exact id or an alias when a word was typed, else the provider
 * the given variables detect as.
 */
async function resolveOneClickPreset(
  deps: AccountCommandDeps,
  word: string | undefined,
  sampleForDetection: Readonly<Record<string, string>>,
): Promise<FleetProviderPresetView> {
  const bin = deps.binaryName;
  const catalog = await deps.gateway.presets();
  if (word !== undefined) {
    const match = matchPresetWord(catalog.presets, word);
    if (match === undefined)
      throw new AccountCommandError(`There is no provider "${word}": see \`${bin} login presets\``);
    if (match.alsoMatched.length > 0) {
      deps.out.warn(`"${word}" could also mean ${match.alsoMatched.join(', ')} — using ${match.preset.label}.`);
    }
    return match.preset;
  }
  const detection = detectProvider(detectionTable(catalog), sampleForDetection);
  const preset = catalog.presets.find(entry => entry.id === detection.preset);
  deps.out.report(detectionSentence(preset, detection));
  if (preset === undefined) {
    throw new AccountCommandError(`Name a tool or provider: ${bin} login add claude|codex|<provider>`);
  }
  return preset;
}

/**
 * Fills in a login's secrets (docs/provider-presets.md §2–3): reuse what the store already has, else a
 * value the shell already carries, else ask — hidden on a terminal, piped on stdin off one when
 * exactly one is still missing, else refused by name with the command to pipe each one in.
 */
async function resolveProviderSecrets(
  deps: AccountCommandDeps,
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
  shellEnv: Readonly<Record<string, string>>,
): Promise<void> {
  const needed = presetSecretsNeeded(preset, harnesses);
  const already = needed.length === 0 ? new Set<string>() : await deps.gateway.secretNames();
  const pending: (typeof needed)[number][] = [];
  for (const need of needed) {
    if (already.has(need.name)) {
      deps.out.report(`${need.name}: already set ✓`);
      continue;
    }
    const fromShell = secretFromShell(need, shellEnv);
    if (fromShell !== undefined) {
      await deps.gateway.putSecret(need.name, fromShell);
      continue;
    }
    pending.push(need);
  }
  if (pending.length === 0) return;
  if (deps.interactive) {
    for (const need of pending) {
      const value = (await deps.prompt.askHidden(`${need.name}: `)).trim();
      if (value === '') throw new AccountCommandError(`${need.name} is needed for ${preset.label} — fill it in`);
      await deps.gateway.putSecret(need.name, value);
    }
    return;
  }
  if (pending.length === 1) {
    const need = pending[0] as (typeof pending)[number];
    await deps.gateway.putSecret(need.name, await deps.readSecretValue());
    return;
  }
  const names = pending.map(need => need.name);
  throw new AccountCommandError(
    `${names.join(', ')} are needed for ${preset.label} — pipe each in: ${names
      .map(name => `printf %s "$${name}" | ${deps.binaryName} secret set ${name}`)
      .join('; ')}`,
  );
}

/**
 * Fills in a login's plain variables (docs/provider-presets.md §2–4): a shell value where `--from-env`
 * applies, then `--env`, then a required one still empty is asked on a terminal or refused by name.
 */
async function resolveProviderPlainEnv(
  deps: AccountCommandDeps,
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
  given: Readonly<Record<string, string>>,
  shellEnv: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  let env = withShellPlainValues(preset, harnesses, presetDefaultEnv(preset, harnesses), shellEnv);
  env = { ...env, ...given };
  for (const variable of presetRequiredPlainGaps(preset, harnesses, env)) {
    if (deps.interactive) {
      const prompt =
        variable.description === undefined ? `${variable.name}: ` : `${variable.name} (${variable.description}): `;
      const answer = (await deps.prompt.ask(prompt)).trim();
      if (answer === '') throw new AccountCommandError(`${variable.name} is needed for ${preset.label} — fill it in`);
      env[variable.name] = answer;
      continue;
    }
    throw new AccountCommandError(`${variable.name} is needed for ${preset.label} — pass --env ${variable.name}=VALUE`);
  }
  return env;
}

/**
 * `fy login add <provider>`, `--from-env` and a bare `--env` (docs/provider-presets.md §2–4): one
 * login, made from a preset, that drives every CLI the preset offers with one secret.
 */
async function addProviderLogin(
  deps: AccountCommandDeps,
  word: string | undefined,
  options: {
    readonly label?: string;
    readonly id?: string;
    readonly env?: Record<string, string>;
    readonly cloudCredential?: string;
    readonly for?: string;
    readonly fromEnv?: boolean;
    readonly test?: boolean;
  } & Record<string, unknown>,
): Promise<void> {
  const bin = deps.binaryName;
  const given = options.env ?? {};
  const fromEnv = options.fromEnv === true;
  const forHarness = options.for === undefined ? undefined : parseHarness(options.for);

  const sample = fromEnv ? definedEnv(deps.env) : given;
  const preset = await resolveOneClickPreset(deps, word, sample);
  const refusal = presetOfferedRefusal(preset);
  if (refusal !== undefined) throw new AccountCommandError(refusal);

  const placement = resolveAddHarness(preset, forHarness);
  if ('refusal' in placement) throw new AccountCommandError(placement.refusal);
  const harness = placement.harness;
  const harnesses = offeredHarnesses(preset);
  const shellEnv = fromEnv ? sample : {};

  const env = await resolveProviderPlainEnv(deps, preset, harnesses, given, shellEnv);
  await resolveProviderSecrets(deps, preset, harnesses, shellEnv);

  const taken = new Set((await deps.gateway.credentials()).credentials.map(entry => entry.id));
  const id = options.id ?? suggestCredentialId(harness, options.label ?? preset.id, taken);
  const flags = writeFlags(options);
  const cloudCredential = options.cloudCredential ?? preset.cloudCredential?.suggested;

  const outcome = await runChange(deps, {
    change: {
      kind: 'credential.add',
      id,
      harness,
      store: 'environment',
      preset: preset.id,
      env,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(cloudCredential === undefined ? {} : { cloudCredential }),
    },
    destructive: false,
    options: flags,
  });
  if (outcome === undefined || flags.json) return;
  deps.out.success(`${id} added — ${presetDriveSentence(preset)}.`);
  if (options.test === true) {
    const result = await deps.gateway.test(id, false);
    deps.out.report(`${id}: ${result.message}`);
    if (!result.ok) deps.out.setExitCode(1);
    return;
  }
  deps.out.report(`Test it: ${bin} login test ${id}`);
}

/** Commander's collector for a repeated `--env NAME=VALUE`. */
function collectEnv(pair: string, into: Record<string, string>): Record<string, string> {
  const separator = pair.indexOf('=');
  if (separator <= 0) throw new AccountCommandError(`Write --env as NAME=VALUE, not ${pair}`);
  return { ...into, [pair.slice(0, separator)]: pair.slice(separator + 1) };
}

/**
 * The environment half of `credential add` (docs/provider-presets.md): nothing when none of its options
 * is given, else an environment login — from a preset's variables when one is named, each overridden
 * by an `--env`, a secret as `${secret:NAME}` and never a value.
 */
async function environmentLogin(
  deps: AccountCommandDeps,
  harness: AccountHarness,
  options: { readonly preset?: string; readonly env?: Record<string, string>; readonly cloudCredential?: string },
): Promise<
  | Record<string, never>
  | {
      readonly store: 'environment';
      readonly preset?: string;
      readonly env: Record<string, string>;
      readonly cloudCredential?: string;
    }
> {
  const given = options.env ?? {};
  if (options.preset === undefined && Object.keys(given).length === 0 && options.cloudCredential === undefined) {
    return {};
  }
  const preset =
    options.preset === undefined
      ? undefined
      : (await deps.gateway.presets()).presets.find(entry => entry.id === options.preset);
  if (options.preset !== undefined && preset === undefined) {
    throw new AccountCommandError(`There is no preset ${options.preset}: see \`${deps.binaryName} login presets\``);
  }
  if (preset !== undefined && preset.harness !== harness) {
    throw new AccountCommandError(
      `${preset.label} is a preset for ${HARNESS_LABEL[preset.harness]}, not ${HARNESS_LABEL[harness]}`,
    );
  }
  const defaults = Object.fromEntries(
    (preset?.variables ?? []).map(variable => [
      variable.name,
      variable.kind === 'secret' ? `\${secret:${variable.secret ?? variable.name}}` : (variable.value ?? ''),
    ]),
  );
  const cloudCredential = options.cloudCredential ?? preset?.cloudCredential?.suggested;
  return {
    store: 'environment',
    ...(preset === undefined ? {} : { preset: preset.id }),
    env: { ...defaults, ...given },
    ...(cloudCredential === undefined ? {} : { cloudCredential }),
  };
}
