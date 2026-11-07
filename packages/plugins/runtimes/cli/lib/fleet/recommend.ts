import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { flagOn, flagSet } from './account-commands.ts';
import type { AccountCommandDeps } from './account-ports.ts';
import { AccountCommandError } from './account-ports.ts';
import { renderRecommendation } from './render.ts';

/**
 * `recommend <task...>`: the daemon owns the routing catalog, so this only asks and prints.
 *
 * `--no-usage` skips quota probing (the guide then reports quota inputs as missing); `--json` prints the payload.
 */
export async function runRecommend(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const task = invocation.args.join(' ').replaceAll(/\s+/gu, ' ').trim();
  if (task === '') {
    throw new AccountCommandError(`describe the task: ${deps.binaryName} recommend "<what needs doing>"`);
  }
  const recommendation = await deps.gateway.recommend({ task, usage: flagSet(invocation.options, 'usage') !== false });
  deps.out.success(
    flagOn(invocation.options, 'json') ? JSON.stringify(recommendation, null, 2) : renderRecommendation(recommendation),
  );
}
