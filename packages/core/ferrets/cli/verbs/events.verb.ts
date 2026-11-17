import { EventsController } from '../lib/events/controller.ts';
import { followFerret } from '../lib/stream/followed.ts';
import { ClientEventStream } from '../lib/stream/gateway.ts';
import { count } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, client, verb, json, first }) => ({
  // `fy events <id>` (V-0258): one ferret's journal after a cursor, read through the stream's socket.
  'events <id>': verb(async (invocation, _presenter, io) => {
    const after = count(invocation, 'after');
    const limit = count(invocation, 'limit');
    const options = {
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
      ...json(invocation),
    };
    // The socket knows ids only; a callsign is resolved by the daemon first (V-0258).
    await followFerret(api, first(invocation, 'ferret id'), async ferretId => {
      await new EventsController(new ClientEventStream(client), io).read(ferretId, options);
    });
  }),
}));
