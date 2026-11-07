import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { hostOf } from './lib/host.ts';
import { packVerbs } from './lib/verbs.ts';

/**
 * Packs' CLI half (docs/pack-mode.md): `fy new` (a helper on a chosen model), `fy wait`, `fy recommend`, `fy pack` (a
 * lead's table of its helpers) and `fy guide` (the routing prompt, its builder, accept and undo). The daemon decides;
 * these ask and print.
 */
export default implementCli(manifest, {
  build: context => ({ verbs: packVerbs({ client: context.client, io: context.io, host: hostOf(context) }) }),
});
