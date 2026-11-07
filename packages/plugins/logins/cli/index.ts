import { type CliContext, implementCli, type TerminalIo, type VerbHandler } from '@ferretry/kernel/manifest';
import { milliseconds as durationOf } from '@ferretry/std';
import manifest from '../manifest.ts';
import { ClientLoginsGateway } from './lib/gateway.ts';
import {
  loginCheck,
  loginChangeUnavailable,
  loginLs,
  loginModelsList,
  loginModelsRefresh,
  loginPresets,
  loginSignin,
  loginTest,
  type VerbBody,
} from './lib/commands.ts';
import { type ILoginsOutput, type LoginsCommandDeps, LoginsCommandError } from './lib/ports.ts';

/**
 * The command name every hint names.
 * GAP(app-shell): `CliContext` does not carry the binary name (single-sourced in `packages/cli/package.json`).
 */
const BINARY_NAME = 'fy';

/** The terminal as these verbs print through it; the exit code a verb sets is read back by the caller. */
function outputOver(io: TerminalIo): ILoginsOutput & { readonly exitCode: () => number } {
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

/** Every verb the manifest declares, by its exact verb line. A verb the manifest adds is a type error here. */
const VERB_BODIES = {
  'login ls': loginLs,
  'login add': loginChangeUnavailable('login add'),
  'login check': loginCheck,
  'login test': loginTest,
  'login presets': loginPresets,
  'login signin': loginSignin,
  'login signout': loginChangeUnavailable('login signout'),
  'login disable': loginChangeUnavailable('login disable'),
  'login enable': loginChangeUnavailable('login enable'),
  'login label': loginChangeUnavailable('login label'),
  'login rm': loginChangeUnavailable('login rm'),
  'login models list': loginModelsList,
  'login models refresh': loginModelsRefresh,
} as const satisfies Record<string, VerbBody>;

/** A verb as the shell calls it: its own output and exit code, and a plain-words refusal as exit 1. */
function handler(ctx: CliContext<typeof manifest>, body: VerbBody): VerbHandler {
  return async invocation => {
    const out = outputOver(ctx.io);
    const ask = ctx.prompt;
    const deps: LoginsCommandDeps = {
      gateway: new ClientLoginsGateway(ctx.client),
      out,
      binaryName: BINARY_NAME,
      ...(ctx.io.isTty && ask !== undefined
        ? { prompt: { ask: async (question: string) => (await ask(question)) ?? '' } }
        : {}),
      // GAP(app-shell): `CliContext.sleep` and `clock` are optional until the fy shell fills them in. Without a timer a
      // sign-in would poll the daemon in a tight loop, so it is refused in words; without a clock the sign-in's own
      // deadline is left to the daemon, which bounds every flow in minutes.
      sleep: async milliseconds => {
        if (ctx.sleep === undefined) {
          throw new LoginsCommandError(
            'This command line has no timer to wait on a sign-in with. Sign in from the app.',
          );
        }
        await ctx.sleep(durationOf(milliseconds));
      },
      now: () => ctx.clock?.nowMs() ?? 0,
    };
    try {
      await body(deps, invocation);
    } catch (error) {
      if (!(error instanceof LoginsCommandError)) throw error;
      out.error(error.message);
      out.setExitCode(1);
    }
    return out.exitCode();
  };
}

/**
 * Logins (cli half, §2.3): `fy login …` — the logins on this machine, whether each works, signing one in through the
 * harness's own flow, a provider test, the presets and the model catalogs. Each verb is today's, over the shell's
 * guarded client; the daemon holds no token while a sign-in runs.
 */
export default implementCli(manifest, {
  build: ctx => ({
    verbs: Object.fromEntries(Object.entries(VERB_BODIES).map(([verb, body]) => [verb, handler(ctx, body)])) as Record<
      keyof typeof VERB_BODIES,
      VerbHandler
    >,
  }),
});
