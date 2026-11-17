/** Lifecycle signals: the signal route, `fy signal` and `fy wait`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { FLEET_USE, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0371 (today's mounts/session-signal.ts, renamed).
    route('POST /v1/ferrets/:ferretId/signal', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a lifecycle signal is recorded in the ferret history, as today' },
      guard: { none: 'answers the ferret state' },
    }),
  ],
  cli: [
    verb('wait <id>', {
      summary: 'block until a ferret settles; exits 0 finished, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout',
      args: [{ name: 'id', help: 'session id' }],
      options: [
        { flag: '--json', help: 'print the session state as one line of JSON' },
        { flag: '--timeout <seconds>', help: 'give up after this many seconds (exit 124)' },
        {
          flag: '--interval <seconds>',
          help: 'how often to ask the daemon again (default: after 1 s, slowing to every 5 s while the session is still)',
        },
        { flag: '--until-marker <file>', help: 'wait for this file rather than trusting a completion claim' },
        {
          flag: '--keep',
          help: 'leave the session running after its result is collected (a settled wait stops it otherwise)',
        },
      ],
    }),
    verb('signal <kind> [message...]', {
      summary: 'done | help | waiting | working — the teammate lifecycle signals',
      args: [
        { name: 'kind', help: 'done, help, waiting, or working' },
        { name: 'message', help: 'optional signal detail; required for help', optional: true, variadic: true },
      ],
      options: [
        { flag: '--session <id>', help: 'session id or callsign; defaults to FY_SESSION_ID' },
        { flag: '--until <when>', help: 'waiting deadline as a duration (45m, 2h) or ISO timestamp' },
        { flag: '--on <condition>', help: 'what external condition is being waited for' },
        { flag: '--peer <id>', help: 'park until this teammate sends a reply' },
        { flag: '--json', help: 'print the resulting session as JSON' },
      ],
    }),
  ],
});
