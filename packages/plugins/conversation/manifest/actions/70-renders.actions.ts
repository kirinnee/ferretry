/** Pictures a ferret can show in a message: the three render routes, `fy render` and `fy render guide`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { RENDER_SAVED_AUDIT } from '../../contract/index.ts';
import { FERRET, fragment, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('POST /v1/renders', { ...FERRET, audit: { record: RENDER_SAVED_AUDIT }, ...SECRETS }),
    route('GET /v1/renders/:id/meta', { ...FERRET, ...READ, ...SECRETS }),
    // The payload is content-addressed and immutable: cacheable, so no `noStore`.
    route('GET /v1/renders/:id', { minimum: 'operator', caller: 'any', ...READ, ...SECRETS }),
  ],
  cli: [
    verb('render', { summary: 'save a picture a ferret can show in a message', args: [] }),
    verb('render guide', {
      summary: 'how to write a render',
      args: [
        {
          name: 'type',
          help: 'mermaid, svg, html, chart, map, image, video, audio, pdf, lottie, card, board',
          optional: true,
        },
      ],
    }),
  ],
});
