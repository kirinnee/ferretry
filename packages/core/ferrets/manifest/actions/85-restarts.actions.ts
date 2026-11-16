/** The restart queue: the restart routes and `fy restart`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { ferretRead, FLEET_CONFIGURE, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // Restarts (today's mounts/session-restart.ts, paths unchanged).
    // R-0323
    route('POST /v1/restarts', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { skip: 'a restart is recorded in each ferret history, as today' },
      guard: { none: 'ferret ids and what was restarted or queued' },
    }),
    // R-0128
    ferretRead('GET /v1/restarts', {
      audit: { skip: 'a restart list records nothing' },
      guard: { none: 'outdated ferret ids and the waiting restarts' },
    }),
    // R-0023
    route('DELETE /v1/restarts', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { skip: 'clearing the restart queue records nothing, as today' },
      guard: { none: 'how many waiting restarts were cleared' },
    }),
  ],
  cli: [
    verb('restart [ids...]', {
      summary:
        'restart ferrets on the same runtime, keeping the conversation; a busy one waits for its next idle moment',
      args: [
        {
          name: 'ids',
          help: 'session ids or callsigns to restart (with none and no flag: show what is out of date)',
          optional: true,
          variadic: true,
        },
      ],
      options: [
        { flag: '--outdated', help: 'restart every ferret whose instructions are out of date' },
        { flag: '--all', help: 'restart every running ferret' },
        { flag: '--cancel', help: 'clear the restarts that are waiting for a ferret to go idle' },
        { flag: '--request-id <id>', help: 'stable idempotency key for an explicit retry of this restart' },
        { flag: '--json', help: 'print the result as JSON' },
      ],
    }),
  ],
});
