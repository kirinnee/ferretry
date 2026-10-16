import type { Command } from 'commander';
import { requireMayApply } from '../fleet/account-authority.ts';
import { runChange } from '../fleet/account-change.ts';
import { parseHarness, readOptions, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError, type AccountHarness } from '../fleet/account-ports.ts';
import { HARNESS_LABEL } from '../fleet/account-render.ts';
import { runSignIn } from '../fleet/sign-in.ts';
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
    .description('add, check, sign in, sign out, label or remove a login');

  writeOptions(
    credential
      .command('add')
      .description('add a login and sign it in')
      .argument('<tool>', 'claude or codex')
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
      .option('--cloud-credential <reference>', 'aws-profile:<name>, gcloud-adc[:<path>] or azure-cli'),
  ).action(
    async (
      tool: string,
      options: {
        label?: string;
        id?: string;
        signIn?: boolean;
        preset?: string;
        env?: Record<string, string>;
        cloudCredential?: string;
      } & Record<string, unknown>,
    ) => {
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
    deps.out.report(options.json ? JSON.stringify(view, null, 2) : renderCredentialRow(view).join('\n'));
    if (view.status.word === 'needs_sign_in') {
      if (!options.json) deps.out.error(`${id} needs sign-in: ${bin} credential signin ${id}`);
      deps.out.setExitCode(1);
    }
  });

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
