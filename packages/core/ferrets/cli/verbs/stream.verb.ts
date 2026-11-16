import { SessionCommandError } from '../lib/session/errors.ts';
import { runCancellableStream, StreamController } from '../lib/stream/controller.ts';
import { ClientEventStream } from '../lib/stream/gateway.ts';
import { on, text, typed } from '../lib/verb-io.ts';
import { BINARY, defineVerbs } from './context.ts';

export default defineVerbs(({ client, verb }) => ({
  // `fy stream [id]`: one ferret from `--after`, or the fleet's recent tail; ends on SIGINT/SIGTERM (today's rules).
  'stream [id]': verb(async (invocation, _presenter, io) => {
    const raw = text(invocation, 'after');
    if (raw === undefined && typed(invocation, 'after')) throw new SessionCommandError('--after needs a sequence');
    const id = invocation.args[0]?.trim();
    await runCancellableStream(
      new StreamController(new ClientEventStream(client), io, BINARY),
      id === '' ? undefined : id,
      { ...(raw === undefined ? {} : { after: Number(raw) }), ...(on(invocation, 'json') ? { json: true } : {}) },
      process,
    );
  }),
}));
