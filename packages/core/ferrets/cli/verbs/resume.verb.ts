import { ResumeSessionController } from '../lib/session/lifecycle-controllers.ts';
import { joined } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, verb, json, first }) => ({
  'resume <id> [message...]': verb(async (invocation, presenter) => {
    const message = joined(invocation.args.slice(1));
    await new ResumeSessionController(api, presenter).execute(first(invocation, 'ferret id'), {
      ...(message === undefined ? {} : { message }),
      ...json(invocation),
    });
  }),
}));
