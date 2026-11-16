import { SessionCommandError } from '../lib/session/errors.ts';
import { SessionStatusController } from '../lib/session/status-controller.ts';
import { SessionSubtreeController } from '../lib/session/subtree-controller.ts';
import { on, text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, environment, verb, json }) => ({
  'status [id]': verb(async (invocation, presenter) => {
    // The shell cannot know `--subtree` is a switch, so `status --subtree wren` arrives as the option VALUE `wren`
    // (v4 took the id as the positional): either spelling names the ferret.
    const spaced = text(invocation, 'subtree');
    const named = spaced === undefined || spaced === 'true' || spaced === 'false' ? undefined : spaced;
    const subtree = on(invocation, 'subtree') || named !== undefined;
    const id = invocation.args[0] ?? named;
    if (subtree) return await new SessionSubtreeController(api, presenter, environment).execute(id, json(invocation));
    if (id === undefined) throw new SessionCommandError('missing the ferret id: status <id>, or status --subtree <id>');
    await new SessionStatusController(api, presenter).execute(id, json(invocation));
  }),
}));
