import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { buildConnectorVerbs } from './lib/commands.ts';

/** Connector (cli half): `fy connector`, `fy connector status|approve|deny|revoke`. */
export default implementCli(manifest, {
  build: ({ client, io, clock }) => ({ verbs: buildConnectorVerbs(client, io, () => clock?.nowMs() ?? 0) }),
});
