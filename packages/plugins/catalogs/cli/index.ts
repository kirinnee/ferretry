import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { BlockQrEncoder } from './adapters/qr.ts';
import { catalogTerminal } from './adapters/terminal.ts';
import { workingDirectory } from './adapters/working-directory.ts';
import { CatalogController } from './lib/catalog/controller.ts';
import { ClientCatalogGateway } from './lib/catalog/gateway.ts';
import { CatalogInstallController } from './lib/catalog-install/controller.ts';
import { ClientCatalogInstallGateway } from './lib/catalog-install/gateway.ts';
import { ShareController } from './lib/catalog-share/controller.ts';
import { ClientSharingGateway } from './lib/catalog-share/gateway.ts';

/** The binary's name, for sentences that name a command. */
const BINARY = 'fy';
const USAGE = 2;

/** The string an option holds (its last, when repeated). */
const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
};

/** Every value a repeatable option was given, in order (today's commander `collect`). */
const list = (invocation: VerbInvocation, name: string): string[] => {
  const value = invocation.options[name];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return [...(value as readonly string[])];
  return [];
};

/** Whether a switch is on; `-y` is `--yes`, as today. */
const on = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

/**
 * Catalogs (cli half, §2.3): `fy catalog …` publishes skills and MCP setups as signed catalogs, installs one from a
 * signed file, and shares catalogs with people; `fy member …` manages who joined. Each verb is today's controller
 * over the shell's guarded client. Write positionals before options.
 */
export default implementCli(manifest, {
  build: ctx => {
    const terminal = catalogTerminal(ctx as never);
    const { io } = ctx;
    const catalogsGateway = new ClientCatalogGateway(ctx.client);
    const catalogs = new CatalogController(
      catalogsGateway,
      terminal.out,
      terminal.prompt,
      terminal.writer,
      terminal.interactive,
      workingDirectory(),
    );
    const installs = new CatalogInstallController({
      gateway: new ClientCatalogInstallGateway(ctx.client),
      files: terminal.reader,
      out: terminal.out,
      prompt: terminal.prompt,
      interactive: terminal.interactive,
      cwd: workingDirectory(),
      binaryName: BINARY,
    });
    const sharing = new ShareController({
      sharing: new ClientSharingGateway(ctx.client),
      catalogs: catalogsGateway,
      out: terminal.out,
      screen: terminal.screen,
      qr: new BlockQrEncoder(),
      terminal: terminal.size,
      prompt: terminal.prompt,
      interactive: terminal.interactive,
      binaryName: BINARY,
    });

    /**
     * Runs one verb: a usage mistake answers 2, a controller's own refusal is printed and answers 1, and a shell
     * refusal (the daemon's final "no", a paused plugin) carries its own exit code and goes back to the shell.
     */
    const verb =
      (needs: number, line: string, work: (args: readonly string[], invocation: VerbInvocation) => Promise<void>) =>
      async (invocation: VerbInvocation): Promise<number> => {
        if (invocation.args.length < needs) {
          io.err(`usage: ${BINARY} ${line}`);
          return USAGE;
        }
        try {
          await work(invocation.args, invocation);
        } catch (error) {
          if (error instanceof Error && typeof (error as { exitCode?: unknown }).exitCode === 'number') throw error;
          io.err(error instanceof Error ? error.message : String(error));
          return 1;
        }
        return terminal.out.exitCode;
      };
    const json = (invocation: VerbInvocation) => defined({ json: on(invocation, 'json') || undefined });
    const confirmed = (invocation: VerbInvocation) =>
      defined({ ...json(invocation), yes: on(invocation, 'yes', 'y') || undefined });

    return {
      verbs: {
        'catalog ls': verb(0, 'catalog ls [--json]', async (_args, invocation) => {
          await catalogs.list(json(invocation));
        }),
        'catalog create': verb(1, 'catalog create <name> [--description <text>]', async ([name], invocation) => {
          await catalogs.create(
            String(name),
            defined({ ...json(invocation), description: text(invocation, 'description') }),
          );
        }),
        'catalog rename': verb(2, 'catalog rename <catalog> <name>', async ([catalog, name], invocation) => {
          await catalogs.rename(String(catalog), String(name), json(invocation));
        }),
        'catalog describe': verb(
          2,
          'catalog describe <catalog> <description>',
          async ([catalog, description], invocation) => {
            await catalogs.describe(String(catalog), String(description), json(invocation));
          },
        ),
        'catalog default': verb(1, 'catalog default <catalog>', async ([catalog], invocation) => {
          await catalogs.makeDefault(String(catalog), json(invocation));
        }),
        'catalog rm': verb(1, 'catalog rm <catalog> [--yes]', async ([catalog], invocation) => {
          await catalogs.remove(String(catalog), confirmed(invocation));
        }),
        'catalog add': verb(
          1,
          'catalog add <catalog> --skill <source> | --mcp <source> | --item <item> [--summary <text>] [--yes]',
          async ([catalog], invocation) => {
            await catalogs.add(
              String(catalog),
              defined({
                ...confirmed(invocation),
                skill: text(invocation, 'skill'),
                mcp: text(invocation, 'mcp'),
                item: text(invocation, 'item'),
                summary: text(invocation, 'summary'),
              }),
            );
          },
        ),
        'catalog publish': verb(2, 'catalog publish <catalog> <item> [--yes]', async ([catalog, item], invocation) => {
          await catalogs.publish(String(catalog), String(item), confirmed(invocation));
        }),
        'catalog versions': verb(2, 'catalog versions <catalog> <item>', async ([catalog, item], invocation) => {
          await catalogs.versions(String(catalog), String(item), json(invocation));
        }),
        'catalog withdraw': verb(
          2,
          'catalog withdraw <catalog> <item> [--yes]',
          async ([catalog, item], invocation) => {
            await catalogs.withdraw(String(catalog), String(item), confirmed(invocation));
          },
        ),
        'catalog export': verb(
          1,
          'catalog export <catalog> [--item <item>]... [--out <file>] [--force] [--yes]',
          async ([catalog], invocation) => {
            const items = list(invocation, 'item');
            await catalogs.export(
              String(catalog),
              defined({
                ...confirmed(invocation),
                item: items.length === 0 ? undefined : items,
                out: text(invocation, 'out'),
                force: on(invocation, 'force') || undefined,
              }),
            );
          },
        ),
        'catalog install': verb(
          1,
          'catalog install <file> [--item <name>] (--project <root> --harness claude|codex | --runtime <name> --profile <name>) [--bind <placeholder=secret>]... [--unbound <placeholder>]... [--older] [--yes]',
          async ([file], invocation) => {
            await installs.install(
              String(file),
              defined({
                ...confirmed(invocation),
                item: text(invocation, 'item'),
                project: text(invocation, 'project'),
                harness: text(invocation, 'harness'),
                runtime: text(invocation, 'runtime'),
                profile: text(invocation, 'profile'),
                bind: list(invocation, 'bind'),
                unbound: list(invocation, 'unbound'),
                older: on(invocation, 'older') || undefined,
              }),
            );
          },
        ),
        'catalog installs': verb(0, 'catalog installs [--json]', async (_args, invocation) => {
          await installs.installs(json(invocation));
        }),
        'catalog uninstall': verb(1, 'catalog uninstall <installId> [--yes]', async ([installId], invocation) => {
          await installs.uninstall(String(installId), confirmed(invocation));
        }),
        'catalog share': verb(
          1,
          'catalog share <catalog>... (--member <name> | --to <person>) --expires 15m|1h|3h|8h|1d [--multi [--cap <count>]] [--large] [--yes]',
          async (args, invocation) => {
            await sharing.share(
              args,
              defined({
                ...confirmed(invocation),
                member: text(invocation, 'member'),
                to: text(invocation, 'to'),
                expires: text(invocation, 'expires'),
                multi: on(invocation, 'multi') || undefined,
                cap: text(invocation, 'cap'),
                large: on(invocation, 'large') || undefined,
              }),
            );
          },
        ),
        'catalog shares': verb(0, 'catalog shares [--json]', async (_args, invocation) => {
          await sharing.shares(json(invocation));
        }),
        'catalog unshare': verb(1, 'catalog unshare <share>', async ([share], invocation) => {
          await sharing.unshare(String(share), json(invocation));
        }),
        'member ls': verb(0, 'member ls [--json]', async (_args, invocation) => {
          await sharing.members(json(invocation));
        }),
        'member rename': verb(2, 'member rename <member> <name>', async ([member, name], invocation) => {
          await sharing.rename(String(member), String(name), json(invocation));
        }),
        'member revoke': verb(1, 'member revoke <member> [--yes]', async ([member], invocation) => {
          await sharing.revoke(String(member), confirmed(invocation));
        }),
        'member forget-key': verb(2, 'member forget-key <member> <key> [--yes]', async ([member, key], invocation) => {
          await sharing.forgetKey(String(member), String(key), confirmed(invocation));
        }),
        'member take': verb(2, 'member take <member> <catalog> [--yes]', async ([member, catalog], invocation) => {
          await sharing.take(String(member), String(catalog), confirmed(invocation));
        }),
      },
    };
  },
});
