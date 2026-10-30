import type { FleetRuntimeView } from '@ferretry/protocol';
import type { Command } from 'commander';
import { runChange } from '../fleet/account-change.ts';
import { readOptions, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { parseReason, parseUntil } from '../fleet/disable-until.ts';
import { renderRuntime, renderRuntimeList } from './render.ts';

/** One runtime by name, or a refusal naming the list command. */
async function findRuntime(deps: AccountCommandDeps, name: string): Promise<FleetRuntimeView> {
  const runtime = (await deps.gateway.runtimes()).runtimes.find(entry => entry.name === name);
  if (runtime === undefined) {
    throw new AccountCommandError(
      `There is no runtime called "${name}". See them all with \`${deps.binaryName} runtimes\`.`,
    );
  }
  return runtime;
}

interface RuntimeFlags extends Record<string, unknown> {
  readonly credential?: string;
  readonly profile?: string;
  readonly agent?: boolean;
  readonly addAnother?: boolean;
}

/** Mounts `runtimes` and `runtime …` (docs/design/account-model.md §6.2). */
export function registerRuntimeCommands(program: Command, deps: AccountCommandDeps): void {
  readOptions(program.command('runtimes').description('the runtimes on this machine: a login plus a profile')).action(
    async (options: { json?: boolean }) => {
      const catalog = await deps.gateway.runtimes();
      deps.out.report(options.json ? JSON.stringify(catalog, null, 2) : renderRuntimeList(catalog, deps.binaryName));
    },
  );

  const runtime = program.command('runtime').description('add, show, change or remove one runtime');

  writeOptions(
    runtime
      .command('add')
      .description('add a runtime: which login, which profile, and whether Ferretry launches it as an agent')
      .argument('<name>', 'the runtime name')
      .requiredOption('--credential <id>', 'the login it uses')
      .requiredOption('--profile <name>', 'the profile it uses')
      .option('--agent', 'Ferretry launches it as an agent: no trust or onboarding prompts, and the agent permissions')
      .option('--add-another', 'add it even when another runtime already uses this login and profile'),
  ).action(async (name: string, options: RuntimeFlags) => {
    await runChange(deps, {
      change: {
        kind: 'runtime.put',
        name,
        credential: options.credential as string,
        profile: options.profile as string,
        agent: options.agent === true,
        create: true,
        ...(options.addAnother === true ? { addAnother: true } : {}),
      },
      destructive: false,
      options: writeFlags(options),
    });
  });

  readOptions(
    runtime
      .command('show')
      .description('one runtime: its stack, models and fixed layer')
      .argument('<name>', 'the runtime'),
  ).action(async (name: string, options: { json?: boolean }) => {
    const found = await findRuntime(deps, name);
    deps.out.report(options.json ? JSON.stringify(found, null, 2) : renderRuntime(found));
  });

  writeOptions(
    runtime
      .command('set')
      .description('change which login or profile a runtime uses, or whether it is an agent')
      .argument('<name>', 'the runtime')
      .option('--credential <id>', 'the login it uses')
      .option('--profile <name>', 'the profile it uses')
      .option('--agent', 'Ferretry launches it as an agent')
      .option('--no-agent', 'it is not launched as an agent'),
  ).action(async (name: string, options: RuntimeFlags) => {
    if (options.credential === undefined && options.profile === undefined && options.agent === undefined) {
      throw new AccountCommandError('Say what to change: --credential, --profile, --agent or --no-agent.');
    }
    const current = await findRuntime(deps, name);
    await runChange(deps, {
      change: {
        kind: 'runtime.put',
        name,
        credential: options.credential ?? current.credential.id,
        profile: options.profile ?? current.profile,
        agent: options.agent ?? current.agent,
        create: false,
      },
      destructive: true,
      options: writeFlags(options),
    });
  });

  writeOptions(
    runtime
      .command('disable')
      .description('switch a runtime off without deleting it: nothing new starts on it; running ferrets keep going')
      .argument('<name>', 'the runtime')
      .option('--until <when>', 'switch back on by itself: a date (2026-11-01), a time or a wait (3d, 12h)')
      .option('--reason <text>', 'why, shown beside the switch and in every refusal'),
  ).action(async (name: string, options: { until?: string; reason?: string } & Record<string, unknown>) => {
    await findRuntime(deps, name);
    const reason = parseReason(options.reason);
    await runChange(deps, {
      change: {
        kind: 'runtime.disable',
        name,
        ...(reason === undefined ? {} : { reason }),
        ...(options.until === undefined ? {} : { until: parseUntil(options.until, deps.now()) }),
      },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    runtime.command('enable').description('switch a disabled runtime back on').argument('<name>', 'the runtime'),
  ).action(async (name: string, options: Record<string, unknown>) => {
    await findRuntime(deps, name);
    await runChange(deps, {
      change: { kind: 'runtime.enable', name },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    runtime
      .command('rename')
      .description('give a runtime a new name; the old one keeps starting it and nothing restarts')
      .argument('<name>', 'the runtime')
      .argument('<new-name>', 'its new name'),
  ).action(async (name: string, to: string, options: Record<string, unknown>) => {
    await runChange(deps, {
      change: { kind: 'runtime.rename', name, to },
      destructive: true,
      options: writeFlags(options),
    });
  });

  writeOptions(
    runtime.command('rm').alias('remove').description('remove a runtime').argument('<name>', 'the runtime'),
  ).action(async (name: string, options: Record<string, unknown>) => {
    await runChange(deps, {
      change: { kind: 'runtime.remove', name },
      destructive: true,
      options: writeFlags(options),
    });
  });
}
