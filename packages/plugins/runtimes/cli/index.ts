import {
  type CliContext,
  ConfigItems,
  implementCli,
  itemVerb,
  type TerminalIo,
  type VerbHandler,
  type VerbInvocation,
} from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ClientRuntimesGateway } from './lib/fleet/account-gateway.ts';
import { AccountCommandError, type AccountCommandDeps, type IAccountOutput } from './lib/fleet/account-ports.ts';
import { parseKind, readComponents, renderComponents } from './lib/components/catalog.ts';
import { instructionsItemKind } from './lib/components/instructions.ts';
import { VERB_BODIES, type VerbBody } from './lib/verbs.ts';

const on = (invocation: VerbInvocation, name: string): boolean =>
  invocation.options[name] === true || invocation.options[name] === 'true';

/** `fy components [kind]`: every component on this machine, read from the files the owning plugins hold. */
function componentsVerb(ctx: CliContext<typeof manifest>): VerbHandler {
  return async invocation =>
    await itemVerb(ctx, async () => {
      const word = invocation.args[0];
      const parsed = word === undefined ? undefined : parseKind(word);
      if (parsed !== undefined && 'refusal' in parsed) {
        ctx.io.err(`${parsed.refusal}\n`);
        return 1;
      }
      const only = parsed?.kind;
      const groups = await readComponents(ctx.client, only);
      ctx.io.out(
        `${on(invocation, 'json') ? JSON.stringify({ kinds: groups }, null, 2) : renderComponents(groups, BINARY_NAME, only)}\n`,
      );
      return 0;
    });
}

/**
 * The command name every hint names.
 * GAP(app-shell): `CliContext` does not carry the binary name (single-sourced in `packages/cli/package.json`).
 */
const BINARY_NAME = 'fy';

/** The terminal as these verbs print through it; the exit code a verb sets is read back by the caller. */
function outputOver(io: TerminalIo): IAccountOutput & { readonly exitCode: () => number } {
  let code = 0;
  return {
    success: message => io.out(`${message}\n`),
    report: message => io.out(`${message}\n`),
    warn: message => io.err(`${message}\n`),
    error: message => io.err(`${message}\n`),
    setExitCode: value => {
      code = value;
    },
    exitCode: () => code,
  };
}

/** A verb as the shell calls it: its own output and exit code, and a plain-words refusal as exit 1. */
function handler(ctx: CliContext<typeof manifest>, body: VerbBody): VerbHandler {
  return async invocation => {
    const out = outputOver(ctx.io);
    const deps: AccountCommandDeps = {
      gateway: new ClientRuntimesGateway(ctx.client),
      out,
      binaryName: BINARY_NAME,
    };
    try {
      await body(deps, invocation);
    } catch (error) {
      if (!(error instanceof AccountCommandError)) throw error;
      out.error(error.message);
      out.setExitCode(1);
    }
    return out.exitCode();
  };
}

export default implementCli(manifest, {
  build: ctx => {
    const instructions = new ConfigItems(
      {
        client: ctx.client,
        io: ctx.io,
        binary: BINARY_NAME,
        ...(ctx.confirm === undefined ? {} : { confirm: ctx.confirm }),
      },
      instructionsItemKind(ctx.readText),
    );
    const item = (body: () => Promise<number>): Promise<number> => itemVerb(ctx, body);
    return {
      verbs: {
        components: componentsVerb(ctx),
        'instruction ls': async invocation => await item(() => instructions.ls({ json: on(invocation, 'json') })),
        'instruction show': async invocation =>
          await item(() => instructions.show(invocation.args[0], { json: on(invocation, 'json') })),
        'instruction add': async invocation => await item(() => instructions.add(invocation)),
        'instruction edit': async invocation => await item(() => instructions.edit(invocation)),
        'instruction rm': async invocation => await item(() => instructions.remove(invocation)),
        runtimes: handler(ctx, VERB_BODIES.runtimes),
        'runtime ls': handler(ctx, VERB_BODIES['runtime ls']),
        'runtime add': handler(ctx, VERB_BODIES['runtime add']),
        'runtime show': handler(ctx, VERB_BODIES['runtime show']),
        'runtime set': handler(ctx, VERB_BODIES['runtime set']),
        'runtime disable': handler(ctx, VERB_BODIES['runtime disable']),
        'runtime enable': handler(ctx, VERB_BODIES['runtime enable']),
        'runtime rename': handler(ctx, VERB_BODIES['runtime rename']),
        'runtime rm': handler(ctx, VERB_BODIES['runtime rm']),
        'runtime link': handler(ctx, VERB_BODIES['runtime link']),
        'runtime scan': handler(ctx, VERB_BODIES['runtime scan']),
        profiles: handler(ctx, VERB_BODIES.profiles),
        'profile ls': handler(ctx, VERB_BODIES['profile ls']),
        'profile show': handler(ctx, VERB_BODIES['profile show']),
        'profile build': handler(ctx, VERB_BODIES['profile build']),
        'profile edit': handler(ctx, VERB_BODIES['profile edit']),
        'profile rm': handler(ctx, VERB_BODIES['profile rm']),
        'model-set ls': handler(ctx, VERB_BODIES['model-set ls']),
        'model-set show': handler(ctx, VERB_BODIES['model-set show']),
        'model-set add': handler(ctx, VERB_BODIES['model-set add']),
        'model-set edit': handler(ctx, VERB_BODIES['model-set edit']),
        'model-set rm': handler(ctx, VERB_BODIES['model-set rm']),
      },
    };
  },
});
