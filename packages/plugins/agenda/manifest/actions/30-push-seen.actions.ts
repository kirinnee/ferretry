/**
 * `POST /v1/push/seen` is Agenda's (DECISIONS-1 #4: it is about an ask the owner opened). The push SUBSCRIPTION routes
 * (`/v1/push/subscriptions`, `/vapid`) are ACCESS': `push.json` and `push-keys.json` are Access state (§9.2).
 */
import { manifestFragment, route } from '@ferretry/kernel/manifest';
import { cap } from '../../contract/index.ts';

export default manifestFragment({
  routes: [
    route('POST /v1/push/seen', {
      minimum: 'operator',
      caller: 'person',
      capability: cap('fleet', 'use'),
      noStore: true,
      audit: { skip: 'the owner opened an ask; the call carries no content and changes nothing but a seen mark' },
      guard: { none: 'an ask id and a board id' },
    }),
  ],
});
