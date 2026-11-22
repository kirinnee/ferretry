import type { CliContext, Manifest, VerbInvocation } from '@ferretry/kernel/manifest';
import type { AsksController } from './controller.ts';
import { RouteAgendaGateway } from './gateway.ts';
import type { IAgendaPrompt } from './ports.ts';
import { type Flags, type GrammarName, readVerb } from './verb-flags.ts';

/** What the item verbs read of the shell: the plugin client, the terminal, the environment, files, the clock and a yes. */
type ItemVerbContext<M extends Manifest> = Pick<
  CliContext<M>,
  'client' | 'io' | 'env' | 'readText' | 'clock' | 'confirm'
>;

/**
 * The wiring every item verb shares, whichever plugin declares it: Asks' (`add`, `show`, `ls`, `done`, `dismiss`) and
 * Agenda's owner-side ones. `make` builds the controller (Asks' own, or Agenda's that extends it) over the gateway, the
 * terminal and the ferret this process runs inside (`FY_SESSION_ID`). `item` is one verb: its grammar reads the words as
 * typed, the controller does the rest, and a failure is its sentence with exit 1 as v4's parser did.
 */
export function itemVerbs<M extends Manifest, C extends AsksController>(
  ctx: ItemVerbContext<M>,
  make: (...args: ConstructorParameters<typeof AsksController>) => C,
) {
  const { client, io, env, readText, clock, confirm } = ctx;
  const own = env?.FY_SESSION_ID?.trim() || undefined;
  const prompt: IAgendaPrompt | undefined =
    io.isTty && confirm !== undefined
      ? { interactive: () => true, ask: async question => ((await confirm(question)) ? 'y' : 'n') }
      : undefined;
  const controller = (): C =>
    make(
      new RouteAgendaGateway(client, own),
      { success: message => io.out(`${message}\n`), diagnostic: message => io.err(`${message}\n`) },
      own,
      readText === undefined ? undefined : { read: readText },
      () => {
        if (clock === undefined) throw new Error('this fy has no clock to read a time against');
        return clock.nowMs();
      },
      prompt,
    );
  /** What a refused flag or word costs: the sentence, and exit 1 as v4's parser did (an unknown SUB-VERB is the shell's exit 2). */
  const refused = (message: string): number => {
    io.err(`${message}\n`);
    return 1;
  };
  const item =
    (verb: GrammarName, run: (c: C, args: readonly string[], flags: Flags) => Promise<void>) =>
    async (invocation: VerbInvocation): Promise<number> => {
      const read = readVerb(verb, invocation);
      if (!read.ok) return refused(read.message);
      try {
        await run(controller(), read.args, read.flags);
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
      return 0;
    };
  return { prompt, refused, item };
}
