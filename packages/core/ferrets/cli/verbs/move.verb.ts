import { randomUUID } from 'node:crypto';
import { moveOptions } from '../lib/move/commands.ts';
import { MoveController } from '../lib/move/controller.ts';
import { ClientMoveGateway } from '../lib/move/gateway.ts';
import { NO_PROGRESS, PlainProgress } from '../lib/progress/index.ts';
import { on } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ client, verb, first }) => ({
  // `fy ferret move <id>` (today's `fy migrate`, §1.4): one destructive call under a logical request id.
  'ferret move <id>': verb(async (invocation, presenter, io) => {
    const id = first(invocation, 'ferret id or callsign');
    const progress = on(invocation, 'json') ? NO_PROGRESS : new PlainProgress(line => io.diagnostic(line));
    await new MoveController(
      new ClientMoveGateway(client, () => randomUUID(), process.pid),
      presenter,
      progress,
    ).execute(id, moveOptions(invocation));
  }),
}));
