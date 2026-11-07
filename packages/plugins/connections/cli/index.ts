import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { buildTunnelVerbs } from './tunnel/commands.ts';

/** Connections (cli half, §4.9): `fy tunnel`, `fy tunnel status`, `fy tunnel on`, `fy tunnel off`. */
export default implementCli(manifest, {
  build: ({ client, io }) => ({ verbs: buildTunnelVerbs(client, io) }),
});
