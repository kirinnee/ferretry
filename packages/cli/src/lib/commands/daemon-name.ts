/**
 * `fy daemon name [<name>|--clear]`: what this machine is called, on every device.
 *
 * No argument says the name and where it comes from (the owner's, or the host name). `<name>` sets it, `--clear` goes
 * back to the host name. Both change `config/host.yaml` through the daemon's configuration routes, the way Settings ›
 * General › Name does: the daemon checks the name (one rule, the same for both) and the CLI holds none of its own.
 */
import { z } from 'zod';
import { DaemonRefusal, EXIT } from '../errors.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

const KERNEL = 'kernel' as const;
const HOST_FILE = 'host.yaml';

const InventorySchema = z.looseObject({ daemonName: z.string().optional() });
const FileSchema = z.looseObject({ exists: z.boolean(), text: z.string(), etag: z.string().min(1) });
const InvalidBodySchema = z.looseObject({
  error: z.string().min(1),
  issues: z.array(z.looseObject({ message: z.string() })).default([]),
});

const read = async (ctx: ShellContext) => {
  const client = ctx.client(KERNEL);
  const [file, inventory] = await Promise.all([
    client.call('GET /v1/config/file', { query: { path: HOST_FILE } }).then(body => FileSchema.parse(body)),
    client.call('GET /v1/plugins').then(body => InventorySchema.parse(body)),
  ]);
  return { file, name: inventory.daemonName, owned: file.exists && /^name:/mu.test(file.text) };
};

/** The refusal's own sentences (a name the daemon will not take), else the failure as it came. */
const refused = (ctx: ShellContext, error: unknown): number => {
  const invalid = error instanceof DaemonRefusal ? InvalidBodySchema.safeParse(error.body) : undefined;
  if (invalid?.success !== true) throw error;
  ctx.world.io.err(`${[...invalid.data.issues.map(issue => issue.message), invalid.data.error].join('\n')}\n`);
  return EXIT.failure;
};

export const daemonName: ShellVerb = async ctx => {
  const { io, identity } = ctx.world;
  const clear = ctx.invocation.options.clear === true || ctx.invocation.options.clear === 'true';
  const given = ctx.invocation.args.join(' ');
  if (clear && given !== '') {
    io.err(
      `give a name or --clear, not both: \`${identity.binary} daemon name <name>\` or \`${identity.binary} daemon name --clear\`\n`,
    );
    return EXIT.usage;
  }
  const now = await read(ctx);
  if (!clear && given === '') {
    io.out(
      `name    ${now.name ?? '(unknown: this daemon is older than the machine name)'}\nsource  ${now.owned ? 'set by the owner (config/host.yaml)' : 'the host name'}\n`,
    );
    return EXIT.ok;
  }
  try {
    if (clear) {
      if (!now.owned) {
        io.out(`already using the host name: ${now.name ?? ''}\n`);
        return EXIT.ok;
      }
      await ctx.client(KERNEL).call('DELETE /v1/config/file', { query: { path: HOST_FILE, etag: now.file.etag } });
    } else {
      // A JSON string is a valid YAML scalar, so any printable character needs no escaping of its own here.
      await ctx.client(KERNEL).call('PUT /v1/config/file', {
        body: { path: HOST_FILE, text: `name: ${JSON.stringify(given)}\n`, etag: now.file.etag },
      });
    }
  } catch (error) {
    return refused(ctx, error);
  }
  io.out(clear ? 'back to the host name\n' : `this machine is now called ${given.trim()}\n`);
  return EXIT.ok;
};
