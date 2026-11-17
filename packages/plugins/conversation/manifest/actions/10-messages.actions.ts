/** Saying something to a ferret: `fy send`, `fy reply`, `fy answer` and `fy interrupt`, and the app's Stop turn. */
import { verb, appAction } from '@ferretry/kernel/manifest';
import { MessageSent } from '../../contract/index.ts';
import { fragment } from '../kit.ts';

export default fragment({
  cli: [
    verb('send', {
      summary: 'say a message to a ferret',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'message', help: 'the message text', optional: true, variadic: true },
      ],
      options: [
        { flag: '-s, --session <id>', help: 'send as this ferret; defaults to the one this runs inside', hidden: true },
        { flag: '-f, --file <file>', help: 'attach a supported image or document; repeatable (default: [])' },
        { flag: '--message-file <file>', help: 'read the message from a file (use for long messages)' },
        { flag: '--now', help: 'interrupt the active turn and deliver immediately instead of riding the queue' },
        { flag: '--ask', help: 'label this as needing a reply and park this session until the peer answers' },
        { flag: '--expect-reply', help: 'label this as needing a reply, without parking this session' },
        {
          flag: '--until <when>',
          help: 'with --ask: give up waiting after this long (45m, 2h, or an ISO timestamp)',
        },
        { flag: '--wait', help: 'wait until the message is proven delivered, timed out, or unconfirmed' },
        {
          flag: '--kind <kind>',
          help: "blocker | action | fyi (default action): how soon it is delivered — a blocker at once, actions combined for a minute, an fyi held until the receiver's turn ends",
        },
        { flag: '--json', help: 'print the session as JSON' },
      ],
    }),
    verb('reply', {
      summary: 'answer the ferret that last wrote to you',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'message', help: 'the reply text', variadic: true },
      ],
      options: [
        {
          flag: '-s, --session <id>',
          help: 'reply as this ferret; defaults to the one this runs inside',
          hidden: true,
        },
        { flag: '-f, --file <file>', help: 'attach a supported image or document; repeatable', hidden: true },
        { flag: '--message-file <file>', help: 'read the reply from a file', hidden: true },
        { flag: '--now', help: 'interrupt the active turn and deliver immediately', hidden: true },
        { flag: '--until <when>', help: 'give up waiting after this long', hidden: true },
        { flag: '--wait', help: 'wait until the reply is proven delivered', hidden: true },
        {
          flag: '--kind <kind>',
          help: "blocker | action | fyi (default action): how soon it is delivered — a blocker at once, actions combined for a minute, an fyi held until the receiver's turn ends",
        },
        { flag: '--json', help: 'print the session as JSON' },
      ],
    }),
    verb('answer', {
      summary: "answer a ferret's question",
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'labels', help: 'the option labels to choose', optional: true, variadic: true },
      ],
      options: [
        { flag: '--other <text>', help: 'choose the free-form Other response for one question' },
        { flag: '--response <answer>', help: 'answer each question in order; repeatable (default: [])' },
        { flag: '--json', help: 'print the session as JSON' },
      ],
    }),
    verb('interrupt', {
      summary: "stop a ferret's turn",
      args: [{ name: 'id', help: 'session id or callsign' }],
      options: [{ flag: '--json', help: 'print the session as JSON' }],
    }),
  ],
  app: [
    appAction('turn.interrupt', { on: 'ferret', label: 'Stop turn', calls: 'POST /v1/ferrets/:ferretId/interrupt' }),
  ],
  data: { publishes: [MessageSent] },
});
