/** Starting a ferret: `POST /v1/ferrets`, its recovery read, `fy start` and `fy new`. */
import { AUDIT_KINDS } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { ferretRead, FLEET_CONFIGURE, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0332
    route('POST /v1/ferrets', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      // B2: a governed device's start outside every project is `terminal.use` (route-security/launch.ts). Gate gives a call
      // its grant standing only when the route asks for it, so without this the decision has no standing to read.
      consultsGrants: true,
      audit: { record: AUDIT_KINDS['session.opened'] },
      guard: { none: 'answers the new ferret id only' },
    }),
    // R-0187: four segments deep with a literal third, so it never matches a ferret id. The payload digest is the proof.
    ferretRead('GET /v1/ferrets/by-request/:requestId', {
      audit: { skip: 'a start recovery read records nothing, as today' },
      guard: { none: 'one ferret identity record, for the caller that proves it sent the start' },
    }),
  ],
  cli: [
    verb('start [prompt...]', {
      summary: 'start a ferret on one of your agent runtimes',
      args: [{ name: 'prompt', help: 'the task prompt; required for --mode auto', optional: true, variadic: true }],
      options: [
        {
          flag: '-a, --agent <agent>',
          help: 'the runtime to run it on, such as claude-default (--runtime also works); leave it out to use this machine’s default runtime for new agents',
        },
        {
          flag: '--parent <id>',
          help: 'start it under this ferret; one started inside a pane inherits that pane by default',
        },
        {
          flag: '-f, --file <file>',
          help: 'attach a supported image or document to the opening message; repeatable',
        },
        {
          flag: '--request-id <id>',
          help: 'idempotency key: running start again with the same id returns the same ferret',
        },
        {
          flag: '--mode <mode>',
          help: 'auto for an autonomous teammate (the default), interactive for a human terminal',
        },
        { flag: '--name <title>', help: 'task title shown in `ps` and the dashboard; free-form, kept verbatim' },
        { flag: '--teammate <callsign>', help: 'use this callsign instead of auto-assigning one' },
        {
          flag: '--teammate-fallback',
          help: 'with --teammate: auto-assign a free callsign instead of failing on a collision',
        },
        { flag: '--label <label>', help: 'ownership label; filter later with `ps --label`' },
        {
          flag: '--card <id>',
          help: 'an existing card it takes over (assigned to it; no second card is made); needs a prompt',
        },
        { flag: '--prompt-file <file>', help: 'read the prompt from a file instead of the command line' },
        { flag: '--model <model>', help: 'override the model (alias or full id)' },
        { flag: '--effort <level>', help: 'the reasoning effort' },
        {
          flag: '--fast',
          help: "launch in the harness's fast mode (faster output; the model must offer it, and it can cost more)",
        },
        { flag: '--no-fast', help: 'launch with fast mode off, even where the login would otherwise turn it on' },
        {
          flag: '--compact-at <tokens|auto>',
          help: "squeeze this ferret's conversation at this many tokens (e.g. 250k); auto leaves the harness's own trigger",
        },
        { flag: '--rc', help: 'launch with remote control so the session is steerable from the web surface' },
        { flag: '--no-rc', help: 'launch without remote control' },
        { flag: '--harness <harness>', help: 'start on this harness (claude or codex) instead of the runtime’s own' },
        { flag: '--login <id>', help: 'start on this login' },
        { flag: '--pack <label>', help: 'put it in this pack' },
        { flag: '--harness-flag <flag>', help: 'extra flag passed straight to the agent binary; repeatable' },
        { flag: '--cwd <dir>', help: 'working directory for it (defaults to this one)' },
        { flag: '--interval <seconds>', help: 'supervision interval' },
        { flag: '--turn-timeout <seconds>', help: 'kill it when one turn runs longer than this' },
        { flag: '--nudge-after <seconds>', help: 'zero life signs for this long earns a continue nudge' },
        { flag: '--stall-kill-after <seconds>', help: 'zero life signs for this long is a stall kill' },
        {
          flag: '--direct-max <chars>',
          help: 'short single-line payloads up to this length are typed verbatim (0 disables)',
        },
        { flag: '--max-snapshots <count>', help: 'pane snapshots to retain' },
        {
          flag: '--detach',
          help: 'return as soon as the ferret is recorded; the launch carries on in the background',
        },
        { flag: '--json', help: 'print the session as JSON' },
      ],
    }),
    verb('new [words...]', {
      summary: 'start a helper ferret (Pack mode); needs --runtime <name> or --auto',
      args: [{ name: 'words', help: 'the complete brief for the helper', optional: true, variadic: true }],
      options: [
        {
          flag: '--runtime <name>',
          help: 'the runtime to run it on (`fy recommend` lists them); name one, or pass --auto',
        },
        {
          flag: '--auto',
          help: 'let Ferretry choose the runtime: the models the routing prompt names, in its order; do not name a runtime with it',
        },
        { flag: '--allow-scratch', help: 'run it in a temporary or scratch folder anyway (refused otherwise)' },
        {
          flag: '--continue',
          help: 'same as `fy link [words]`: list the conversations to continue (starts no helper; takes only --since and --harness)',
        },
        { flag: '--since <dur>', help: 'same as `fy link --since <n>d|h|w`: only conversations active since then' },
        {
          flag: '--mode <mode>',
          help: 'auto for an autonomous teammate (the default), interactive for a human terminal',
        },
        { flag: '--name <title>', help: 'task title shown in `ps` and the dashboard; free-form, kept verbatim' },
        { flag: '--teammate <callsign>', help: 'use this callsign instead of auto-assigning one' },
        {
          flag: '--teammate-fallback',
          help: 'with --teammate: auto-assign a free callsign instead of failing on a collision',
        },
        { flag: '--label <label>', help: 'ownership label; filter later with `ps --label`' },
        {
          flag: '--card <id>',
          help: 'an existing card it takes over (assigned to it; no second card is made); needs a prompt',
        },
        { flag: '--prompt-file <file>', help: 'read the prompt from a file instead of the command line' },
        { flag: '--model <model>', help: 'override the model (alias or full id)' },
        { flag: '--effort <level>', help: 'the reasoning effort' },
        {
          flag: '--fast',
          help: "launch in the harness's fast mode (faster output; the model must offer it, and it can cost more)",
        },
        { flag: '--no-fast', help: 'launch with fast mode off, even where the login would otherwise turn it on' },
        {
          flag: '--compact-at <tokens|auto>',
          help: 'squeeze its conversation at this many tokens (e.g. 250k); auto leaves the default',
        },
        { flag: '--rc', help: 'launch with remote control so the session is steerable from the web surface' },
        { flag: '--no-rc', help: 'launch without remote control' },
        { flag: '--harness <harness>', help: 'start on this harness (claude or codex) instead of the runtime’s own' },
        { flag: '--login <id>', help: 'start on this login' },
        { flag: '--pack <label>', help: 'put it in this pack' },
        { flag: '--harness-flag <flag>', help: 'extra flag passed straight to the agent binary; repeatable' },
        { flag: '--cwd <dir>', help: 'working directory for it (defaults to this one)' },
        { flag: '--interval <seconds>', help: 'supervision interval' },
        { flag: '--turn-timeout <seconds>', help: 'kill it when one turn runs longer than this' },
        { flag: '--nudge-after <seconds>', help: 'zero life signs for this long earns a continue nudge' },
        { flag: '--stall-kill-after <seconds>', help: 'zero life signs for this long is a stall kill' },
        {
          flag: '--direct-max <chars>',
          help: 'short single-line payloads up to this length are typed verbatim (0 disables)',
        },
        { flag: '--max-snapshots <count>', help: 'pane snapshots to retain' },
        { flag: '--json', help: 'print the session as JSON' },
      ],
    }),
  ],
});
