import type { TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import { type IPackIo, PackController } from './controller.ts';
import { ClientPackGateway, type IPackGateway, type PackClient } from './gateway.ts';
import { absoluteOf, ambientFerret, type PackHost } from './host.ts';
import { type ICellColour, PackCommandError, PackTableController } from './pack-table.ts';

/** The shipped command name, which every printed command and stderr note names. */
const BINARY = 'fy';

type Options = VerbInvocation['options'];

/** Whether a flag was given (`--json`, or `--json=true`). */
const flag = (options: Options, ...names: readonly string[]): boolean =>
  names.some(name => options[name] === true || options[name] === 'true');

/** A flag's value; the last one when it was repeated. */
const text = (options: Options, name: string): string | undefined => {
  const value = options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

const AMBER = '\u001b[33m';
const RESET = '\u001b[39m';

/** The terminal's `IPackIo`: stdout is `out`, stderr is `err`, and the exit code is kept for the verb to return. */
class VerbIo implements IPackIo {
  exitCode = 0;
  constructor(private readonly io: TerminalIo) {}
  success(message: string): void {
    this.io.out(`${message}\n`);
  }
  report(message: string): void {
    this.io.out(`${message}\n`);
  }
  interactive(): boolean {
    return this.io.isTty;
  }
  error(message: string): void {
    this.io.err(`${message}\n`);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

/** Runs `act`, then answers its exit code; a failure is one line on stderr and exit 2 (a mistake) or 1 (it failed). */
const run =
  (io: TerminalIo, act: (out: VerbIo, invocation: VerbInvocation) => Promise<void>): VerbHandler =>
  async invocation => {
    const out = new VerbIo(io);
    try {
      await act(out, invocation);
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      return error instanceof PackCommandError ? error.exitCode : 1;
    }
    return out.exitCode;
  };

export interface PackVerbParts {
  readonly client: PackClient;
  readonly io: TerminalIo;
  readonly host: PackHost;
  readonly gateway?: IPackGateway;
}

const GUIDE_HELP = [
  'fy guide: the routing prompt Pack mode picks helper models with',
  '',
  'Commands:',
  '  show        the routing prompt in effect, where it came from, and whether a clean-up can be undone',
  '  inventory   what Clean up is shown: every runtime, its models, readiness and quota, and every model',
  '  clean-up    have a short-lived ferret rewrite the routing prompt to fit (one model run), then review it as a diff',
  '  write       have a short-lived ferret write the routing prompt from a short idea (one model run), then review it',
  '  accept      write a run’s checked rewrite as the routing prompt (undo puts the old one back)',
  '  undo        put back the routing prompt the last accepted clean-up replaced',
  '',
].join('\n');

/** Every verb of the manifest, keyed by its line. */
export function packVerbs(parts: PackVerbParts) {
  const { io, host } = parts;
  const gateway = parts.gateway ?? new ClientPackGateway(parts.client);
  const absolute = absoluteOf(host);
  const readFile = async (path: string): Promise<string> => {
    if (host.readFile === undefined)
      throw new PackCommandError(
        'this terminal cannot read files for a plugin verb yet; pass the text with --prompt',
        2,
      );
    return await host.readFile(path);
  };
  const controller = (out: IPackIo): PackController =>
    new PackController({
      gateway,
      out,
      readFile: async path => await readFile(absolute(path)),
      binaryName: BINARY,
      ...(host.sleep === undefined ? {} : { sleep: host.sleep }),
    });
  const colour: ICellColour = { amber: cell => (io.isTty ? `${AMBER}${cell}${RESET}` : cell) };

  const guideOptions = (options: Options) => ({
    ...(text(options, 'runtime') === undefined ? {} : { runtime: text(options, 'runtime') as string }),
    ...(text(options, 'model') === undefined ? {} : { model: text(options, 'model') as string }),
    ...(flag(options, 'json') ? { json: true } : {}),
    ...(flag(options, 'apply', 'y') ? { apply: true } : {}),
  });

  return {
    'recommend [task...]': run(io, async (out, { args, options }) => {
      await controller(out).recommend(args, flag(options, 'json') ? { json: true } : {});
    }),
    'pack [id]': run(io, async (out, { args, options }) => {
      await new PackTableController(gateway, out, ambientFerret(host), host.nowMs, colour).execute(
        args[0],
        flag(options, 'json') ? { json: true } : {},
      );
    }),
    guide: async () => {
      io.err(GUIDE_HELP);
      return 1;
    },
    'guide show': run(io, async (out, { options }) => {
      await controller(out).showGuide(flag(options, 'json') ? { json: true } : {});
    }),
    'guide inventory': run(io, async (out, { options }) => {
      await controller(out).showInventory(flag(options, 'json') ? { json: true } : {});
    }),
    'guide clean-up': run(io, async (out, { options }) => {
      await controller(out).cleanUp({
        ...guideOptions(options),
        ...(text(options, 'prompt') === undefined ? {} : { prompt: text(options, 'prompt') as string }),
        ...(text(options, 'prompt-file') === undefined ? {} : { promptFile: text(options, 'prompt-file') as string }),
      });
    }),
    'guide write': run(io, async (out, { options }) => {
      await controller(out).write({
        ...guideOptions(options),
        ...(text(options, 'idea') === undefined ? {} : { idea: text(options, 'idea') as string }),
      });
    }),
    'guide accept <run>': run(io, async (out, { args }) => {
      const id = args[0];
      if (id === undefined || id.trim() === '') throw new PackCommandError('missing the run id: guide accept <run>', 2);
      await controller(out).accept(id);
    }),
    'guide undo': run(io, async out => {
      await controller(out).undo();
    }),
  };
}
