import { ListSessionsController } from '../lib/session/ps-controller.ts';
import { on, PLAIN, text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, verb, json }) => ({
  ps: verb(async (invocation, presenter) => {
    const pack = text(invocation, 'pack');
    const label = text(invocation, 'label', 'l');
    await new ListSessionsController(api, presenter, PLAIN).execute({
      ...(on(invocation, 'all', 'a') ? { all: true } : {}),
      ...(pack === undefined ? {} : { pack }),
      ...(label === undefined ? {} : { label }),
      ...json(invocation),
    });
  }),
}));
