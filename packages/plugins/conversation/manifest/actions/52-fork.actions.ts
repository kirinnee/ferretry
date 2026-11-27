/** Forking a ferret into a new one from a message of its conversation: the fork route (c58-37 PR11). */
import { audit } from '@ferretry/core-gate/contract';
import { route } from '@ferretry/kernel/manifest';
import { cap } from '../../contract/index.ts';
import { fragment, PERSON } from '../kit.ts';

export default fragment({
  routes: [
    // R-0344: a person's, and `fleet.configure` (a fork starts a new ferret, so a device narrowed to `fleet.use` is refused).
    route('POST /v1/ferrets/:ferretId/fork', {
      ...PERSON,
      capability: cap('fleet', 'configure'),
      audit: audit('session.opened'),
      guard: { none: 'the new ferret id, its branch and a count; no transcript text, folder or path' },
    }),
  ],
});
