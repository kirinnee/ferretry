/** Callsign suggestions: `GET /v1/names` and `fy name`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0114
    route('GET /v1/names', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      audit: { skip: 'a name suggestion records nothing' },
      guard: { none: 'names from the callsign pool' },
    }),
  ],
  cli: [
    verb('name', {
      summary: 'print available callsigns so a name can be chosen before start',
      args: [],
      options: [
        { flag: '-n, --count <count>', help: 'print this many callsigns' },
        { flag: '--json', help: 'print the callsigns as a JSON array' },
      ],
    }),
  ],
});
