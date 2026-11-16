/** The hypermedia switch: what a ferret may show in its messages. */
import { route } from '@ferretry/kernel/manifest';
import { HYPERMEDIA_CHANGED_AUDIT } from '../../contract/index.ts';
import { ACK, FERRET, fragment, READ } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/hypermedia', { ...FERRET, ...READ, ...ACK }),
    route('PATCH /v1/ferrets/:ferretId/hypermedia', {
      ...FERRET,
      audit: { record: HYPERMEDIA_CHANGED_AUDIT },
      ...ACK,
    }),
  ],
});
