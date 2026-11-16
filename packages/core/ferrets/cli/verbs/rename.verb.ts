import { RenameSessionController } from '../lib/session/rename-controller.ts';
import { text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, verb, json, first }) => ({
  'rename <session> [name]': verb(async (invocation, presenter) => {
    const title = text(invocation, 'title');
    await new RenameSessionController(api, presenter).execute(first(invocation, 'ferret'), invocation.args[1], {
      ...(title === undefined ? {} : { title }),
      ...json(invocation),
    });
  }),
}));
