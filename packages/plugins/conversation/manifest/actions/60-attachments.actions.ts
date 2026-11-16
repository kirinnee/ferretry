/** A message's attachments (session-attachments): add, read, unlock and relock. */
import { route } from '@ferretry/kernel/manifest';
import { ATTACHMENT_ADDED_AUDIT, ATTACHMENT_RELOCKED_AUDIT, ATTACHMENT_UNLOCKED_AUDIT } from '../../contract/index.ts';
import { FERRET, FLEET_USE, fragment, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('POST /v1/ferrets/:ferretId/attachments', {
      ...FERRET,
      audit: { record: ATTACHMENT_ADDED_AUDIT },
      ...SECRETS,
    }),
    route('GET /v1/ferrets/:ferretId/attachments/:attachmentId', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
    route('POST /v1/ferrets/:ferretId/attachments/:attachmentId/unlock', {
      ...FERRET,
      audit: { record: ATTACHMENT_UNLOCKED_AUDIT },
      ...SECRETS,
    }),
    route('DELETE /v1/ferrets/:ferretId/attachments/:attachmentId/unlock', {
      ...FERRET,
      audit: { record: ATTACHMENT_RELOCKED_AUDIT },
      ...SECRETS,
    }),
  ],
});
