import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { FsController } from '../lib/fs/controller.ts';
import { ClientFsGateway } from '../lib/fs/gateway.ts';
import { on, text } from '../lib/verb-io.ts';
import { BINARY, defineVerbs } from './context.ts';

const FS_USAGE = [
  "read a ferret's working tree, never writing it:",
  `  ${BINARY} fs ls <ferret> [path]       list a directory`,
  `  ${BINARY} fs index <ferret>           every searchable file, with what the walk left out (--query <text>)`,
  `  ${BINARY} fs cat <ferret> <path>      one file (--head reads Git HEAD)`,
  `  ${BINARY} fs changes <ferret>         the Git working-tree changes`,
  `  ${BINARY} fs diff <ferret> <path>     the unified diff of one changed path`,
];

// `fy fs ls|index|cat|changes|diff <id>` (V-0262…): read-only, over the file browser's routes.
export default defineVerbs(({ client, verb, json, first, usage }) => {
  const fsVerb = (work: (controller: FsController, invocation: VerbInvocation, ferret: string) => Promise<void>) =>
    verb(async (invocation, _presenter, io) => {
      await work(new FsController(new ClientFsGateway(client), io), invocation, first(invocation, 'ferret id'));
    });
  return {
    fs: usage(FS_USAGE),
    'fs ls <id> [path]': fsVerb(async (fs, invocation, ferret) => {
      await fs.list(ferret, invocation.args[1], json(invocation));
    }),
    'fs index <id>': fsVerb(async (fs, invocation, ferret) => {
      const query = text(invocation, 'query');
      await fs.index(ferret, { ...(query === undefined ? {} : { query }), ...json(invocation) });
    }),
    'fs cat <id> <path>': fsVerb(async (fs, invocation, ferret) => {
      await fs.file(ferret, invocation.args[1] ?? '', {
        ...(on(invocation, 'head') ? { head: true } : {}),
        ...json(invocation),
      });
    }),
    'fs changes <id>': fsVerb(async (fs, invocation, ferret) => {
      await fs.changes(ferret, json(invocation));
    }),
    'fs diff <id> <path>': fsVerb(async (fs, invocation, ferret) => {
      await fs.diff(ferret, invocation.args[1] ?? '', json(invocation));
    }),
  };
});
