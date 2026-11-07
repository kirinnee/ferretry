import { type CliContext, implementCli, type TerminalIo, type VerbHandler } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ClientRuntimesGateway } from './lib/fleet/account-gateway.ts';
import { AccountCommandError, type AccountCommandDeps, type IAccountOutput } from './lib/fleet/account-ports.ts';
import { VERB_BODIES, type VerbBody } from './lib/verbs.ts';

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
  build: ctx => ({
    verbs: {
      'runtime ls': handler(ctx, VERB_BODIES['runtime ls']),
      'runtime add': handler(ctx, VERB_BODIES['runtime add']),
      'runtime show': handler(ctx, VERB_BODIES['runtime show']),
      'runtime set': handler(ctx, VERB_BODIES['runtime set']),
      'runtime disable': handler(ctx, VERB_BODIES['runtime disable']),
      'runtime enable': handler(ctx, VERB_BODIES['runtime enable']),
      'runtime rename': handler(ctx, VERB_BODIES['runtime rename']),
      'runtime rm': handler(ctx, VERB_BODIES['runtime rm']),
      'runtime import': handler(ctx, VERB_BODIES['runtime import']),
      'runtime scan': handler(ctx, VERB_BODIES['runtime scan']),
      recommend: handler(ctx, VERB_BODIES.recommend),
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
  }),
});
