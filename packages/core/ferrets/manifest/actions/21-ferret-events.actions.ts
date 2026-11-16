/** The per-ferret events read (R-0147): one page of one ferret's journal; the stream is `05-events`. */
import { ferretRead, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0147: today's `GET /v1/sessions/:sessionId/events`, renamed with the rest (design §1.4).
    ferretRead('GET /v1/ferrets/:ferretId/events', {
      audit: { skip: 'a read of the journal records nothing' },
      guard: 'secrets',
    }),
  ],
});
