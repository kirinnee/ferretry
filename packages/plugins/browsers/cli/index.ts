import { implementCli, type VerbHandler } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { BUNDLED_FIREWALL_FILES } from './adapters/firewall-files.ts';
import { writePictureFile } from './adapters/picture-file.ts';
import { BrowserClient } from './lib/client.ts';
import { BrowserDispatcher } from './lib/dispatcher.ts';
import { type BrowserVerbLine, verbTable } from './lib/verbs/index.ts';

/**
 * The Browsers `fy` half (§2.3): every `browser …` verb the manifest declares, through ONE dispatcher over a verb
 * table (`lib/verbs`). Composition only: the table says what each verb asks, the dispatcher is the one thing that
 * talks, prints and exits.
 */
export default implementCli(manifest, {
  build: ({ client, io, readText, env }) => {
    const table = verbTable(BUNDLED_FIREWALL_FILES);
    const dispatcher = new BrowserDispatcher(table, new BrowserClient(client), io, {
      ownFerret: env?.FY_SESSION_ID,
      readStdin: async () => {
        if (readText === undefined) throw new Error('this build cannot read standard input here');
        return await readText('-');
      },
      writeFile: writePictureFile,
    });
    const verbs = {} as Record<BrowserVerbLine, VerbHandler>;
    for (const line of Object.keys(table) as BrowserVerbLine[]) verbs[line] = dispatcher.handler(line);
    return { verbs };
  },
});
