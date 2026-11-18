import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { ClientRestartGateway } from '../lib/client.ts';
import { RestartController } from '../lib/restart/controller.ts';
import { requestIdOf } from '../lib/session/start-inputs.ts';
import { on } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

/**
 * `--dry-run` is a safety flag, so it fails closed: it is on unless it was switched off outright (`--no-dry-run`,
 * `--dry-run=false`). `--dry-run=yes` or `=1` is a dry run, never a quiet real restart.
 */
function dryRunAsked(invocation: VerbInvocation): boolean {
  const value = invocation.options['dry-run'];
  return value !== undefined && value !== false && value !== 'false';
}

export default defineVerbs(({ client, verb, json }) => ({
  'restart [ids...]': verb(async (invocation, presenter) => {
    const requestId = requestIdOf(invocation);
    await new RestartController(new ClientRestartGateway(client), presenter).execute(invocation.args, {
      ...(on(invocation, 'outdated') ? { outdated: true } : {}),
      ...(on(invocation, 'all') ? { all: true } : {}),
      ...(on(invocation, 'cancel') ? { cancel: true } : {}),
      ...(dryRunAsked(invocation) ? { dryRun: true } : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...json(invocation),
    });
  }),
}));
