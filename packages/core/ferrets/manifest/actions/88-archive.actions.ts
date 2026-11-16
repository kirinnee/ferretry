/** The archive read: `GET /v1/archived-sessions`. */
import { ferretRead, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0047 (today's mounts/session-archive.ts, path unchanged): how many are archived and the newest, read-only.
    ferretRead('GET /v1/archived-sessions', {
      audit: { skip: 'an archive read records nothing' },
      guard: { none: 'archived ferret identity records' },
    }),
  ],
});
