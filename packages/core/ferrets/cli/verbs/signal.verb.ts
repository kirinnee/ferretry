import { SignalSessionController } from '../lib/session/signal-controller.ts';
import { joined, text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ api, environment, verb, json }) => ({
  'signal <kind> [message...]': verb(async (invocation, presenter) => {
    const [kind = '', ...parts] = invocation.args;
    const session = text(invocation, 'session');
    const until = text(invocation, 'until');
    const condition = text(invocation, 'on');
    const peer = text(invocation, 'peer');
    await new SignalSessionController(api, presenter, environment).execute(kind, joined(parts), {
      ...(session === undefined ? {} : { session }),
      ...(until === undefined ? {} : { until }),
      ...(condition === undefined ? {} : { on: condition }),
      ...(peer === undefined ? {} : { peer }),
      ...json(invocation),
    });
  }),
}));
