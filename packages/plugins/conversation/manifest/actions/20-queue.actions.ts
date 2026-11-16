/** A ferret's queued messages: `fy queue`, `fy queue edit`, `fy queue cancel`, and the app's Withdraw. */
import { appAction, verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  cli: [
    verb('queue <ferret>', {
      summary: "a ferret's queued messages",
      args: [{ name: 'ferret', help: 'the ferret, by name or session id' }],
      options: [{ flag: '--json', help: 'print the queue as JSON' }],
    }),
    verb('queue edit', {
      summary: 'change a queued message before it is typed',
      args: [
        { name: 'ferret', help: 'the ferret, by name or session id' },
        { name: 'id', help: 'the message id, as `fy queue <ferret>` lists it' },
        { name: 'text', help: 'the new words', variadic: true },
      ],
    }),
    verb('queue cancel', {
      summary: 'withdraw a queued message',
      args: [
        { name: 'ferret', help: 'the ferret, by name or session id' },
        { name: 'id', help: 'the message id, as `fy queue <ferret>` lists it' },
      ],
    }),
  ],
  app: [
    appAction('queue.cancel', {
      on: 'ferret',
      label: 'Withdraw',
      calls: 'DELETE /v1/ferrets/:ferretId/queue/:messageId',
    }),
  ],
});
