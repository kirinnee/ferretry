import { ConfigItems, implementCli, itemFlag, itemVerb, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { skillLs } from './lib/inventory.ts';
import { skillsItemKind } from './lib/items.ts';

/** The binary's name every hint names (`CliContext` does not carry it; single-sourced in `packages/cli/package.json`). */
const BINARY_NAME = 'fy';

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

/**
 * Skills: what a ferret or this machine has (`skill ls`, the inventory), and the skills items a profile layers in
 * (`skill show|add|edit|rm`, over the kernel's config routes — the files are `config/skills/<name>.yaml`).
 */
export default implementCli(manifest, {
  build: ({ client, io, env, confirm }) => {
    const items = new ConfigItems(
      { client, io, binary: BINARY_NAME, ...(confirm === undefined ? {} : { confirm }) },
      skillsItemKind,
    );
    const item = (body: () => Promise<number>): Promise<number> => itemVerb({ io }, body);
    return {
      verbs: {
        // Inside a ferret it is THAT ferret's view — what its harness actually reads; `--machine` or outside one, the machine's.
        'skill ls': async invocation => {
          const session =
            itemFlag(invocation, 'session') ?? (on(invocation, 'machine') ? undefined : env?.FY_SESSION_ID);
          return await item(() =>
            skillLs(client, text => io.out(text), {
              ...(session === undefined ? {} : { ferret: session }),
              json: on(invocation, 'json'),
            }),
          );
        },
        'skill show': async invocation =>
          await item(() => items.show(invocation.args[0], { json: on(invocation, 'json') })),
        'skill add': async invocation => await item(() => items.add(invocation)),
        'skill edit': async invocation => await item(() => items.edit(invocation)),
        'skill rm': async invocation => await item(() => items.remove(invocation)),
      },
    };
  },
});
