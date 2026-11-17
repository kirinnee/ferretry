import { SessionCommandError } from '../lib/session/errors.ts';
import { runCancellableStream, StreamController } from '../lib/stream/controller.ts';
import { followFerret } from '../lib/stream/followed.ts';
import { ClientEventStream } from '../lib/stream/gateway.ts';
import { on, text, typed } from '../lib/verb-io.ts';
import { BINARY, defineVerbs } from './context.ts';

export default defineVerbs(({ api, client, verb }) => ({
  // `fy stream [id]`: one ferret from `--after`, or the fleet's recent tail; ends on SIGINT/SIGTERM (today's rules).
  'stream [id]': verb(async (invocation, _presenter, io) => {
    const raw = text(invocation, 'after');
    if (raw === undefined && typed(invocation, 'after')) throw new SessionCommandError('--after needs a sequence');
    const reference = invocation.args[0]?.trim();
    const options = {
      ...(raw === undefined ? {} : { after: Number(raw) }),
      ...(on(invocation, 'json') ? { json: true } : {}),
    };
    const controller = new StreamController(new ClientEventStream(client), io, BINARY);
    // The socket knows ids only; a callsign is resolved by the daemon first, and no reference follows the fleet.
    if (reference === undefined || reference === '')
      await runCancellableStream(controller, undefined, options, process);
    else await followFerret(api, reference, ferretId => runCancellableStream(controller, ferretId, options, process));
  }),
}));
