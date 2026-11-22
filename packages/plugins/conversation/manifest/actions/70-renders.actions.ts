/** Pictures a ferret can show in a message: the three render routes, `fy render`, `fy render guide` and `fy render check`. */
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
      summary: 'how to write a rich message: the terminal part, the references and the fy-render types',
      args: [
        {
          name: 'topic',
          help: 'terminal, human, chart, mermaid, references, svg, html, map, image, video, audio, pdf, lottie, task, board',
          optional: true,
        },
      ],
    }),
    verb('render check', {
      summary: 'check a message for problems before sending it: prints line N: for each, exits 1 on an error',
      args: [{ name: 'file', help: 'a file holding the message, or - for standard input' }],
    }),
  ],
});
