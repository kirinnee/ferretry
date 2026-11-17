/** `fy setup` (V-0436): the shell verb that finishes an install. The order and the refusals are `lib/setup/setup.ts`'s. */
import { milliseconds } from '@ferretry/std';
import { optionOn } from '../argv.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';
import { runSetup, type SetupHealth, type SetupSteps } from '../setup/setup.ts';
import { daemonInstall } from './daemon.ts';

/** A daemon the install has just started may take a moment to bind: this many looks, this far apart. */
const LOOKS = 20;
const LOOK_MS = 500;

async function awaitHealthy(ctx: ShellContext): Promise<SetupHealth> {
  const { world } = ctx;
  let last = await world.probe();
  for (let look = 1; last.state === 'down' && look < LOOKS; look += 1) {
    await world.host.sleep(milliseconds(LOOK_MS));
    last = await world.probe();
  }
  return last.state === 'up'
    ? { up: true, baseUrl: last.baseUrl }
    : { up: false, baseUrl: last.baseUrl, why: last.why };
}

export const setupVerb: ShellVerb = async ctx => {
  const { world } = ctx;
  const json = optionOn(ctx.invocation, 'json');
  const steps: SetupSteps = {
    interactive: world.io.isTty,
    install: () => daemonInstall(ctx),
    health: () => awaitHealthy(ctx),
    pair: () => ctx.runVerb(['pair', '--no-wait']),
    onboard: flags => ctx.runVerb(['onboard', ...flags]),
    say: line => (json ? world.io.err(`${line}\n`) : world.io.out(`${line}\n`)),
    complain: line => world.io.err(`${line}\n`),
  };
  return await runSetup(
    {
      yes: optionOn(ctx.invocation, 'yes') || optionOn(ctx.invocation, 'y'),
      check: optionOn(ctx.invocation, 'check'),
      json,
    },
    steps,
    world.identity.binary,
  );
};
