/** Finding cards and asks (work-search), the two routes. The verb and the agent tool are `65-search.actions.ts` (see there for why). */
import { route } from '@ferretry/kernel/manifest';
import { cap, RELATED_SEARCHED_AUDIT } from '../../contract/index.ts';
import { FERRET, fragment, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/search', { ...FERRET, capability: cap('fleet', 'use'), ...READ, ...SECRETS }),
    route('POST /v1/search/related', {
      ...FERRET,
      capability: cap('fleet', 'use'),
      audit: { record: RELATED_SEARCHED_AUDIT },
      ...SECRETS,
    }),
  ],
});
