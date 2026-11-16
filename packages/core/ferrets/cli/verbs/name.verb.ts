import { SuggestNamesController } from '../lib/session/name-controller.ts';
import { text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, verb, json }) => ({
  name: verb(async (invocation, presenter) => {
    const raw = text(invocation, 'count', 'n');
    await new SuggestNamesController(api, presenter).execute({
      ...(raw === undefined ? {} : { count: Number(raw) }),
      ...json(invocation),
    });
  }),
}));
