import { ClientRestartGateway } from '../lib/client.ts';
import { RestartController } from '../lib/restart/controller.ts';
import { requestIdOf } from '../lib/session/start-inputs.ts';
import { on } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ client, verb, json }) => ({
  'restart [ids...]': verb(async (invocation, presenter) => {
    const requestId = requestIdOf(invocation);
    await new RestartController(new ClientRestartGateway(client), presenter).execute(invocation.args, {
      ...(on(invocation, 'outdated') ? { outdated: true } : {}),
      ...(on(invocation, 'all') ? { all: true } : {}),
      ...(on(invocation, 'cancel') ? { cancel: true } : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...json(invocation),
    });
  }),
}));
