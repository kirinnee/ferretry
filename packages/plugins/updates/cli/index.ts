/** Cached daemon reads stay with the plugin; the shell owns fy update and its transaction. */
import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { parseView, viewLines } from './lib/verb.ts';

export default implementCli(manifest, {
  build: ({ client, io }) => ({
    verbs: {
      'update check': async invocation => {
        const view = parseView(await client.call('GET /v1/daemon/update'));
        io.out(`${invocation.options.json === true ? JSON.stringify(view) : viewLines(view).join('\n')}\n`);
        return 0;
      },
    },
  }),
});
