import type { Command } from 'commander';
import { requireMayApply } from '../fleet/account-authority.ts';
import { runChange } from '../fleet/account-change.ts';
import { parseHarness, readOptions, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError, type AccountHarness } from '../fleet/account-ports.ts';
import { runSignIn } from '../fleet/sign-in.ts';
import { renderCredentialList, renderCredentialRow } from './render.ts';

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
    program.command('credentials').description('the logins on this machine, with their status and usage'),
  ).action(async (options: { json?: boolean }) => {
    const list = await deps.gateway.credentials();
    deps.out.report(options.json ? JSON.stringify(list, null, 2) : renderCredentialList(list, bin));
  });

  const credential = program
    .command('credential')
    .description('add, check, sign in, sign out, label or remove a login');

  writeOptions(
    credential
      .command('add')
      .description('add a login and sign it in')
      .argument('<tool>', 'claude or codex')
      .option('--label <label>', 'a name to tell this login apart from another with the same email')
      .option('--id <id>', 'the id to give it (default: made from the tool and the label)')
      .option('--no-sign-in', 'add the login without signing in now'),
  ).action(
    async (tool: string, options: { label?: string; id?: string; signIn?: boolean } & Record<string, unknown>) => {
      const harness = parseHarness(tool);
      const taken = new Set((await deps.gateway.credentials()).credentials.map(entry => entry.id));
      const id = options.id ?? suggestCredentialId(harness, options.label, taken);
      const flags = writeFlags(options);
      const outcome = await runChange(deps, {
        change: {
          kind: 'credential.add',
          id,
          harness,
          ...(options.label === undefined ? {} : { label: options.label }),
        },
        destructive: false,
        options: flags,
      });
      if (outcome === undefined || flags.json) return;
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
