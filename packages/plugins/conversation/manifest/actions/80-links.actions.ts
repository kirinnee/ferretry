/** Links (§6.2; today's conversation-import and foreign-history): the link and history routes, `fy link` and its verbs. */
import { route, verb } from '@ferretry/kernel/manifest';
import { cap, LinkKept, LINKS_ADOPTED_AUDIT } from '../../contract/index.ts';
import { ACK, FERRET, fragment, PERSON, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/links/conversations', {
      ...FERRET,
      capability: cap('fleet', 'configure'),
      ...READ,
      ...SECRETS,
    }),
    route('GET /v1/links/conversations/:harness/:conversationId/preview', {
      ...FERRET,
      capability: cap('fleet', 'configure'),
      ...READ,
      ...SECRETS,
    }),
    route('POST /v1/links/conversations/keep', {
      ...PERSON,
      capability: cap('fleet', 'configure'),
      audit: { record: LINKS_ADOPTED_AUDIT },
      ...ACK,
    }),
    route('GET /v1/links/history', { ...FERRET, ...READ, ...SECRETS }),
    route('GET /v1/links/history/:entryId', { ...FERRET, ...READ, ...SECRETS }),
  ],
  cli: [
    verb('link [query...]', {
      summary: 'list conversations the harnesses hold, to keep as ferrets',
      args: [
        {
          name: 'query',
          help: 'search words; each must appear in the name, first or latest message or project folder',
          optional: true,
          variadic: true,
        },
      ],
      options: [
        { flag: '--limit <n>', help: 'how many conversations to list', hidden: true },
        { flag: '--source <source>', help: 'only conversations from this source', hidden: true },
        { flag: '--harness <harness>', help: 'only this harness (choices: "claude", "codex")' },
        {
          flag: '--since <duration>',
          help: 'only conversations active within this long: <n>d, <n>h or <n>w (e.g. 7d)',
        },
        { flag: '--select <id...>', help: 'adopt these conversation ids instead of listing' },
        { flag: '--runtime <name>', help: 'the runtime every adopted ferret runs on (required with --select)' },
        {
          flag: '--all',
          help: 'import every conversation as a stopped ferret (needs --runtime; hard-linked, never copied)',
        },
        { flag: '--start', help: 'launch every selected conversation now (at most 10 at once)' },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
    verb('link preview', {
      summary: 'the first words of a conversation',
      args: [
        { name: 'harness', help: 'claude or codex' },
        { name: 'conversation-id', help: 'the conversation’s id' },
      ],
      options: [{ flag: '--json', help: 'print the answer as JSON' }],
    }),
    verb('link keep', {
      summary: 'keep conversations as ferrets, read from the harness file',
      args: [
        { name: 'harness', help: 'claude or codex' },
        { name: 'runtime', help: 'the runtime to keep them on' },
        { name: 'conversation-id', help: 'a conversation to keep', variadic: true },
      ],
      options: [
        { flag: '--start', help: 'also start each one as a ferret' },
        { flag: '--json', help: 'print the answer as JSON' },
      ],
    }),
  ],
  data: { publishes: [LinkKept] },
});
