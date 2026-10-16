import { AGENT_TOOL_DEFAULT_WAIT_MS } from '@ferretry/protocol';
import type { Command } from 'commander';
import { AgentToolsCommandError } from './client.ts';
import type { AgentToolsCommand, IAgentToolsRunner } from './controller.ts';

interface SessionOption {
  readonly session?: string;
}

const SESSION_HELP = 'act on this session yourself; without it, act as the agent session this runs inside';

/** A whole number from the command line, or a plain refusal naming the option. */
export function wholeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed))
    throw new AgentToolsCommandError(`${option} must be a whole number, not "${value}"`);
  return parsed;
}

/** Text given as several words on the command line, as one string; absent when none was given. */
const joined = (words: readonly string[]): string | undefined => (words.length === 0 ? undefined : words.join(' '));

/**
 * Builds a group's verbs over one runner. `--session` is accepted on the group and on every verb, and
 * the one written nearest the verb wins, exactly as the `browser` group reads it.
 */
function verbs(group: Command, runner: IAgentToolsRunner, parents: readonly Command[]) {
  const sessionOf = (options: SessionOption): SessionOption => {
    const session = [options, ...[group, ...parents].map(command => command.opts<SessionOption>())]
      .map(candidate => candidate.session?.trim())
      .find(candidate => candidate !== undefined && candidate !== '');
    return session === undefined ? {} : { session };
  };
  const verb = (name: string, description: string): Command =>
    group.command(name).description(description).option('-s, --session <id>', SESSION_HELP);
  const run = async (command: AgentToolsCommand): Promise<void> => {
    await runner.run(command);
  };
  const call = async (body: Record<string, unknown>, options: SessionOption, extra: object = {}) =>
    await run({ kind: 'call', call: body, ...sessionOf(options), ...extra });
  return { verb, run, call, sessionOf };
}

/**
 * `fy terminal`: the session's terminals, by name — the same actions an agent's `terminal.*` tools
 * take, for scripts and for people.
 */
export function registerTerminalCommands(program: Command, runner: IAgentToolsRunner): void {
  const terminal = program
    .command('terminal')
    .description('open, type into, read and close terminals by name (%terminal:<name>)')
    .option('-s, --session <id>', SESSION_HELP);
  const { verb, run, call, sessionOf } = verbs(terminal, runner, []);

  verb('list', 'list the terminals in the session').action(async (options: SessionOption) => {
    await call({ tool: 'terminal.list' }, options);
  });

  verb('open', 'open a named terminal, optionally running a command in it')
    .argument('<name>', 'its name: a lowercase letter, then letters, digits or dashes')
    .argument('[command...]', 'a command to run in it; use -- before one that starts with a dash')
    .option('-f, --folder <dir>', 'where it starts: absolute, or relative to the session folder')
    .action(async (name: string, command: string[], options: SessionOption & { folder?: string }) => {
      const text = joined(command);
      await call(
        {
          tool: 'terminal.open',
          name,
          ...(options.folder === undefined ? {} : { folder: options.folder }),
          ...(text === undefined ? {} : { command: text }),
        },
        options,
      );
    });

  verb('send', 'type text and press keys in a terminal')
    .argument('<name>', 'the terminal’s name or id')
    .argument('[text...]', 'text to type; use -- before text that starts with a dash')
    .option('-k, --key <key...>', 'keys to press after the text: enter, tab, escape, up, ctrl-c, …')
    .action(async (name: string, text: string[], options: SessionOption & { key?: string[] }) => {
      const typed = joined(text);
      await call(
        {
          tool: 'terminal.send',
          name,
          ...(typed === undefined ? {} : { text: typed }),
          ...(options.key === undefined ? {} : { keys: options.key }),
        },
        options,
      );
    });

  verb('read', 'print the last lines of a terminal')
    .argument('<name>', 'the terminal’s name or id')
    .option('-n, --lines <n>', 'how many lines')
    .action(async (name: string, options: SessionOption & { lines?: string }) => {
      await call(
        {
          tool: 'terminal.read',
          name,
          ...(options.lines === undefined ? {} : { lines: wholeNumber(options.lines, '--lines') }),
        },
        options,
      );
    });

  verb('wait', 'wait until text appears or the running command ends; exits 1 on timeout')
    .argument('<name>', 'the terminal’s name or id')
    .option('--text <text>', 'wait until this text appears')
    .option('--exit', 'wait until the running command ends')
    .option('-t, --timeout <ms>', 'how long to wait in all', String(AGENT_TOOL_DEFAULT_WAIT_MS))
    .action(async (name: string, options: SessionOption & { text?: string; exit?: boolean; timeout: string }) => {
      if ((options.text === undefined) === (options.exit !== true))
        throw new AgentToolsCommandError('wait for one thing: pass --text <text> or --exit');
      await run({
        kind: 'wait',
        wait: {
          name,
          ...(options.text === undefined ? { exit: true } : { text: options.text }),
          totalMs: wholeNumber(options.timeout, '--timeout'),
        },
        ...sessionOf(options),
      });
    });

  verb('close', 'close a terminal')
    .argument('<name>', 'the terminal’s name or id')
    .action(async (name: string, options: SessionOption) => {
      await call({ tool: 'terminal.close', name }, options);
    });

  registerControlVerbs('terminal', verb, run, sessionOf);

  verb('control', 'show which terminals and pages an agent is driving, and which are taken over').action(
    async (options: SessionOption) => {
      await run({ kind: 'view', ...sessionOf(options) });
    },
  );
}

/**
 * `fy browser page`: the session browser's pages, by name — the same actions an agent's `browser.*`
 * tools take. Mounted on the existing `browser` group, which must be registered first.
 */
export function registerBrowserPageCommands(program: Command, runner: IAgentToolsRunner): void {
  const browser = program.commands.find(command => command.name() === 'browser');
  if (browser === undefined) throw new Error('the browser command group must be registered before its page verbs');
  const page = browser
    .command('page')
    .description('open, drive, read and close browser pages by name (%browser:<name>)')
    .option('-s, --session <id>', SESSION_HELP);
  const { verb, run, call, sessionOf } = verbs(page, runner, [browser]);

  verb('list', 'list the browser pages in the session').action(async (options: SessionOption) => {
    await call({ tool: 'browser.list' }, options);
  });

  verb('open', 'open a named page, starting the browser if it is not running')
    .argument('<name>', 'its name: a lowercase letter, then letters, digits or dashes')
    .argument('[url]', 'an http or https URL to load')
    .action(async (name: string, url: string | undefined, options: SessionOption) => {
      await call({ tool: 'browser.open', name, ...(url === undefined ? {} : { url }) }, options);
    });

  verb('navigate', 'load a URL in a page')
    .argument('<name>', 'the page’s name or id')
    .argument('<url>', 'an http or https URL')
    .action(async (name: string, url: string, options: SessionOption) => {
      await call({ tool: 'browser.navigate', name, url }, options);
    });

  verb('click', 'click a selector in a page')
    .argument('<name>', 'the page’s name or id')
    .argument('<selector>', 'what to click; shell-quote a selector containing spaces')
    .action(async (name: string, selector: string, options: SessionOption) => {
      await call({ tool: 'browser.click', name, selector }, options);
    });

  verb('type', 'fill a selector in a page; the text is never logged')
    .argument('<name>', 'the page’s name or id')
    .argument('<selector>', 'what to fill')
    .argument('[text...]', 'text to type; use -- before text that starts with a dash')
    .action(async (name: string, selector: string, text: string[], options: SessionOption) => {
      await call({ tool: 'browser.type', name, selector, text: text.join(' ') }, options);
    });

  verb('read', 'print a page’s visible text, or its accessibility tree')
    .argument('<name>', 'the page’s name or id')
    .option('--a11y', 'the accessibility tree instead of the text')
    .option('--selector <selector>', 'read only this part of the page')
    .action(async (name: string, options: SessionOption & { a11y?: boolean; selector?: string }) => {
      await call(
        {
          tool: 'browser.read',
          name,
          ...(options.a11y === true ? { mode: 'a11y' } : {}),
          ...(options.selector === undefined ? {} : { selector: options.selector }),
        },
        options,
      );
    });

  verb('screenshot', 'save a screenshot of a page')
    .argument('<name>', 'the page’s name or id')
    .argument('<file>', 'where to write the PNG')
    .action(async (name: string, file: string, options: SessionOption) => {
      await call({ tool: 'browser.screenshot', name }, options, { screenshotTo: file });
    });

  verb('close', 'close a page')
    .argument('<name>', 'the page’s name or id')
    .action(async (name: string, options: SessionOption) => {
      await call({ tool: 'browser.close', name }, options);
    });

  registerControlVerbs('browser', verb, run, sessionOf);
}

function registerControlVerbs(
  surface: 'terminal' | 'browser',
  verb: (name: string, description: string) => Command,
  run: (command: AgentToolsCommand) => Promise<void>,
  sessionOf: (options: SessionOption) => SessionOption,
): void {
  const noun = surface === 'terminal' ? 'terminal' : 'page';
  verb('takeover', `take a ${noun} over from the agent: its tools are refused there until you hand it back`)
    .argument('<name>', `the ${noun}’s name or id`)
    .action(async (name: string, options: SessionOption) => {
      await run({ kind: 'control', surface, action: 'takeover', key: name, ...sessionOf(options) });
    });
  verb('handback', `hand a ${noun} back to the agent`)
    .argument('<name>', `the ${noun}’s name or id`)
    .action(async (name: string, options: SessionOption) => {
      await run({ kind: 'control', surface, action: 'handback', key: name, ...sessionOf(options) });
    });
}
