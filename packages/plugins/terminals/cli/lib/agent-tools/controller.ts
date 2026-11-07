import type { TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { AGENT_TOOL_DEFAULT_WAIT_MS } from '../../../contract/index.ts';
import { EXIT_USAGE, joined, UsageError, wholeNumber, Words } from '../args.ts';
import { TERMINAL_MAX_TOTAL_WAIT_MS, type TerminalToolsClient } from './client.ts';
import { renderControlView, renderToolReport } from './render.ts';

/**
 * `fy terminal …`: a ferret's terminals by name — the same acts its `terminal_*` tools take, for scripts and for
 * people (today's `registerTerminalCommands` and `AgentToolsController`, terminal half).
 *
 * `--ferret <id>` (or `-s`, or `--session`, as before) acts on that ferret's terminals as the person at this
 * machine; without it the verb is the ferret this runs inside, acting on its own. Each verb answers its exit code:
 * 0 done, 1 refused or not matched, 2 mistyped.
 */
export class TerminalVerbs {
  constructor(
    private readonly tools: TerminalToolsClient,
    private readonly io: TerminalIo,
  ) {}

  readonly list = this.verb(async (_words, ferret) => await this.tools.call('terminal_list', {}, ferret));

  readonly open = this.verb(async (words, ferret) => {
    const folder = words.text('folder', 'f');
    const ask = words.switchOrText('ask');
    const [name, ...command] = words.args;
    if (name === undefined)
      throw new UsageError('open needs a name: a lowercase letter, then letters, digits or dashes');
    const text = joined(command);
    return await this.tools.call(
      'terminal_open',
      {
        name,
        ...(folder === undefined ? {} : { folder }),
        ...(text === undefined ? {} : { command: text }),
        ...(ask === undefined ? {} : { askOwner: ask }),
      },
      ferret,
    );
  });

  readonly send = this.verb(async (words, ferret) => {
    const keys = words.list('key', 'k');
    const [name, ...text] = words.args;
    if (name === undefined) throw new UsageError('send needs the terminal’s name or id');
    const typed = joined(text);
    return await this.tools.call(
      'terminal_send',
      { name, ...(typed === undefined ? {} : { text: typed }), ...(keys.length === 0 ? {} : { keys }) },
      ferret,
    );
  });

  readonly read = this.verb(async (words, ferret) => {
    const lines = words.text('lines', 'n');
    const [name] = words.args;
    if (name === undefined) throw new UsageError('read needs the terminal’s name or id');
    return await this.tools.call(
      'terminal_read',
      { name, ...(lines === undefined ? {} : { lines: wholeNumber(lines, '--lines') }) },
      ferret,
    );
  });

  readonly wait = this.verb(
    async (words, ferret) => {
      const text = words.text('text');
      const exit = words.on('exit');
      const timeout = words.text('timeout', 't') ?? String(AGENT_TOOL_DEFAULT_WAIT_MS);
      const [name] = words.args;
      if (name === undefined) throw new UsageError('wait needs the terminal’s name or id');
      if ((text === undefined) === !exit) throw new UsageError('wait for one thing: pass --text <text> or --exit');
      const totalMs = wholeNumber(timeout, '--timeout');
      if (!(totalMs >= 100 && totalMs <= TERMINAL_MAX_TOTAL_WAIT_MS))
        throw new UsageError(`--timeout must be between 100 and ${String(TERMINAL_MAX_TOTAL_WAIT_MS)} milliseconds`);
      return await this.tools.wait({ name, ...(text === undefined ? { exit: true } : { text }), totalMs }, ferret);
    },
    { unmatchedFails: true },
  );

  readonly close = this.verb(async (words, ferret) => {
    const [name] = words.args;
    if (name === undefined) throw new UsageError('close needs the terminal’s name or id');
    return await this.tools.call('terminal_close', { name }, ferret);
  });

  readonly ask = this.verb(async (words, ferret) => {
    const [name, ...message] = words.args;
    if (name === undefined) throw new UsageError('ask needs the terminal’s name or id');
    const text = joined(message);
    return await this.tools.call(
      'terminal_ask_owner',
      { name, ...(text === undefined ? {} : { message: text }) },
      ferret,
    );
  });

  readonly takeover = this.controlVerb('takeover');
  readonly handback = this.controlVerb('handback');
  readonly handover = this.controlVerb('handover');

  async control(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const ferret = personal(ferretOf(new Words(invocation)));
      this.io.out(`${renderControlView(await this.tools.view(ferret))}\n`);
      return 0;
    });
  }

  private controlVerb(action: 'takeover' | 'handback' | 'handover') {
    return async (invocation: VerbInvocation): Promise<number> =>
      await this.guard(async () => {
        const words = new Words(invocation);
        const ferret = personal(ferretOf(words));
        const [key] = words.args;
        if (key === undefined) throw new UsageError(`${action} needs the terminal’s name or id`);
        this.io.out(`${renderControlView(await this.tools.control(action, key, ferret))}\n`);
        return 0;
      });
  }

  private verb(
    run: (
      words: Words,
      ferret: string | undefined,
    ) => Promise<{ readonly report: Parameters<typeof renderToolReport>[0]; readonly isError: boolean }>,
    options: { readonly unmatchedFails?: true } = {},
  ) {
    return async (invocation: VerbInvocation): Promise<number> =>
      await this.guard(async () => {
        const words = new Words(invocation);
        const { report, isError } = await run(words, ferretOf(words));
        const text = renderToolReport(report);
        if (isError) {
          this.io.err(`${text}\n`);
          return 1;
        }
        this.io.out(`${text}\n`);
        return options.unmatchedFails === true && report.matched !== true ? 1 : 0;
      });
  }

  private async guard(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof UsageError ? EXIT_USAGE : 1;
    }
  }
}

/** The ferret a person names: `--ferret`, `-s`, or `--session` as before. */
export const ferretOf = (words: Words): string | undefined => {
  const named = words.text('ferret', 'session', 's')?.trim();
  return named === undefined || named === '' ? undefined : named;
};

/** Taking over and handing back are a person's acts on a ferret they name. */
function personal(ferret: string | undefined): string {
  if (ferret === undefined)
    throw new UsageError(
      'this is a person’s action on a ferret: pass --ferret <id> (a ferret cannot take a terminal over from itself)',
    );
  return ferret;
}
