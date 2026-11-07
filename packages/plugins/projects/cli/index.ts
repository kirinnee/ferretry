import { implementCli, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ClientProjectGateway } from './lib/gateway.ts';
import { ProjectController, ProjectInputError } from './lib/project-controller.ts';

/** The binary name the help texts quote; the shell single-sources it (`packages/cli/package.json` `bin`). */
const BINARY = 'fy';

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

/** What the shell may add to the context beyond `client` and `io`: the directory `fy project add .` means. */
interface ShellExtras {
  readonly cwd?: string;
}

/**
 * Projects' CLI half: `fy project add|list|remove`. Registering sends an absolute path, resolved against the caller's
 * directory (the context's `cwd` when the shell supplies one, else this process's own).
 */
export default implementCli(manifest, {
  build: context => {
    const { client, io } = context;
    const cwd = (context as ShellExtras).cwd ?? process.cwd();
    const controller = new ProjectController(
      new ClientProjectGateway(client),
      { success: message => io.out(`${message}\n`) },
      cwd,
      BINARY,
    );
    const guarded =
      (work: (invocation: VerbInvocation) => Promise<void>): VerbHandler =>
      async invocation => {
        try {
          await work(invocation);
          return 0;
        } catch (error) {
          if (error instanceof ProjectInputError) {
            io.err(`${error.message}\n`);
            return 1;
          }
          throw error;
        }
      };
    return {
      verbs: {
        'project add': guarded(async invocation => {
          await controller.add(invocation.args[0] ?? '', {
            name: text(invocation, 'name'),
            json: on(invocation, 'json'),
          });
        }),
        'project list': guarded(async invocation => {
          await controller.list({ json: on(invocation, 'json') });
        }),
        'project remove': guarded(async invocation => {
          await controller.remove(invocation.args[0] ?? '', { json: on(invocation, 'json') });
        }),
      },
    };
  },
});
