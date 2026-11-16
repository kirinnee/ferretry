import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { RuntimeView } from '../../../contract/index.ts';
import { runChange } from '../fleet/account-change.ts';
import { flagOn, flagSet, flagText, positional, writeFlags } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { parseReason, parseUntil } from '../fleet/disable-until.ts';
import { renderRuntime, renderRuntimeList } from './render.ts';

/** One runtime by name, or a refusal naming the list command. */
async function findRuntime(deps: AccountCommandDeps, name: string): Promise<RuntimeView> {
  const runtime = (await deps.gateway.runtimes()).runtimes.find(entry => entry.name === name);
  if (runtime === undefined) {
    throw new AccountCommandError(
      `There is no runtime called "${name}". See them all with \`${deps.binaryName} runtime ls\`.`,
    );
  }
  return runtime;
}

/** `runtime ls`: the Runtimes tab in a terminal. */
export async function runtimeLs(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const catalog = await deps.gateway.runtimes();
  deps.out.report(
    flagOn(invocation.options, 'json') ? JSON.stringify(catalog, null, 2) : renderRuntimeList(catalog, deps.binaryName),
  );
}

/** `runtime add <name> --login <id> --profile <name> [--agent] [--add-another]`. */
export async function runtimeAdd(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const { options } = invocation;
  const name = positional(invocation, 0, 'runtime to add');
  const login = flagText(options, 'login');
  const profile = flagText(options, 'profile');
  if (login === undefined) throw new AccountCommandError('Say which login it uses: --login <id>.');
  if (profile === undefined) throw new AccountCommandError('Say which profile it uses: --profile <name>.');
  await runChange(deps, {
    change: {
      kind: 'runtime.put',
      name,
      credential: login,
      profile,
      agent: flagOn(options, 'agent'),
      create: true,
      ...(flagOn(options, 'add-another') ? { addAnother: true } : {}),
    },
    destructive: false,
    options: writeFlags(options),
  });
}

/** `runtime show <name>`: one runtime, its stack, models and fixed layer. */
export async function runtimeShow(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const found = await findRuntime(deps, positional(invocation, 0, 'runtime to show'));
  deps.out.report(flagOn(invocation.options, 'json') ? JSON.stringify(found, null, 2) : renderRuntime(found));
}

/** `runtime set <name> [--login <id>] [--profile <name>] [--agent | --no-agent]`. */
export async function runtimeSet(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const { options } = invocation;
  const name = positional(invocation, 0, 'runtime to change');
  const login = flagText(options, 'login');
  const profile = flagText(options, 'profile');
  const agent = flagSet(options, 'agent');
  if (login === undefined && profile === undefined && agent === undefined) {
    throw new AccountCommandError('Say what to change: --login, --profile, --agent or --no-agent.');
  }
  const current = await findRuntime(deps, name);
  await runChange(deps, {
    change: {
      kind: 'runtime.put',
      name,
      credential: login ?? current.credential.id,
      profile: profile ?? current.profile,
      agent: agent ?? current.agent,
      create: false,
    },
    destructive: true,
    options: writeFlags(options),
  });
}

/** `runtime disable <name> [--until <when>] [--reason <text>]`. */
export async function runtimeDisable(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const { options } = invocation;
  const name = positional(invocation, 0, 'runtime to switch off');
  await findRuntime(deps, name);
  const reason = parseReason(flagText(options, 'reason'));
  const until = flagText(options, 'until');
  await runChange(deps, {
    change: {
      kind: 'runtime.disable',
      name,
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until: parseUntil(until, deps.now?.()) }),
    },
    destructive: false,
    options: writeFlags(options),
  });
}

/** `runtime enable <name>`. */
export async function runtimeEnable(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'runtime to switch on');
  await findRuntime(deps, name);
  await runChange(deps, {
    change: { kind: 'runtime.enable', name },
    destructive: false,
    options: writeFlags(invocation.options),
  });
}

/** `runtime rename <name> <new-name>`. */
export async function runtimeRename(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'runtime to rename');
  const to = positional(invocation, 1, 'new name it gets');
  await runChange(deps, {
    change: { kind: 'runtime.rename', name, to },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}

/** `runtime rm <name>`. */
export async function runtimeRm(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  await runChange(deps, {
    change: { kind: 'runtime.remove', name: positional(invocation, 0, 'runtime to remove') },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}
