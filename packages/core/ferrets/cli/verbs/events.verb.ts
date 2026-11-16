import { EventsController } from '../lib/events/controller.ts';
import { ClientEventStream } from '../lib/stream/gateway.ts';
import { count } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ client, verb, json, first }) => ({
  // `fy events <id>` (V-0258): one ferret's journal after a cursor, read through the stream's socket.
  'events <id>': verb(async (invocation, _presenter, io) => {
    const after = count(invocation, 'after');
    const limit = count(invocation, 'limit');
    await new EventsController(new ClientEventStream(client), io).read(first(invocation, 'ferret id'), {
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
      ...json(invocation),
    });
  }),
}));
