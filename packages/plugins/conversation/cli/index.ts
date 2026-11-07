import { implementCli, type VerbHandler } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { queueCancelVerb, queueEditVerb, queueVerb } from './lib/queue/commands.ts';
import { ClientQueueGateway } from './lib/queue/gateway.ts';
// PART B REGISTRATION: the verbs of the reader, links, search and renders.
import { readerVerbs } from './reader/index.ts';

/** Exit code a verb that is not ready answers with (the skeleton's), after saying so. */
const NOT_READY = 69;

/**
 * Conversation's cli half. Part a owns the queue verbs. `send`, `reply`, `answer`, `interrupt` and `compact-at` are
 * listed under Ferrets' `fy ferret` commands in the placement table; until that is settled they answer with the
 * sentence below rather than guessing at a second copy of the controllers.
 */
export default implementCli(manifest, {
  build: ctx => {
    const ports = {
      gateway: new ClientQueueGateway(ctx.client),
      out: { report: (message: string) => ctx.io.out(`${message}\n`) },
    };
    const notReady =
      (verb: string): VerbHandler =>
      async () => {
        ctx.io.err(`fy ${verb} is not ready yet in this version of Conversation.\n`);
        return NOT_READY;
      };
    const mine: Record<string, VerbHandler> = {
      queue: queueVerb(ports),
      'queue edit': queueEditVerb(ports),
      'queue cancel': queueCancelVerb(ports),
    };
    const theirs = readerVerbs({ client: ctx.client, io: ctx.io });
    const verbs: Record<string, VerbHandler> = { ...mine, ...theirs };
    for (const declared of manifest.actions.cli) verbs[declared.verb] ??= notReady(declared.verb);
    return { verbs } as never;
  },
});
