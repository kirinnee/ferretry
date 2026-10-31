import { AGENT_TOOL_DEFAULT_WAIT_MS, BROWSER_REF_PATTERN } from '@ferretry/protocol';
import type { Command } from 'commander';
import { AgentToolsCommandError } from './client.ts';
import type { AgentToolsCommand, IAgentToolsRunner } from './controller.ts';

interface SessionOption {
  readonly session?: string;
}

const SESSION_HELP = 'act on this session yourself; without it, act as the agent session this runs inside';
const ASK_HELP =
  'hand it to the owner at once: their tab comes forward with “Your turn here”; optionally say what to do';

/** A whole number from the command line, or a plain refusal naming the option. */
export function wholeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed))
    throw new AgentToolsCommandError(`${option} must be a whole number, not "${value}"`);
  return parsed;
}

/** A point on the command line: `x,y` in viewport CSS pixels. */
const POINT = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/u;

/**
 * What a page act points at, from one command-line word: a ref from `read --snapshot` (`e12`), a point
 * (`120,340`, where the act takes one), or else a selector.
 */
export function targetArgument(
  word: string,
): { readonly ref: string } | { readonly x: number; readonly y: number } | { readonly selector: string } {
  const value = word.trim();
  if (BROWSER_REF_PATTERN.test(value)) return { ref: value };
  const point = POINT.exec(value);
  if (point !== null) return { x: Number(point[1]), y: Number(point[2]) };
  return { selector: word };
}

/** The same, for an act that takes only an element. */
function elementArgument(word: string): { readonly ref: string } | { readonly selector: string } {
  const target = targetArgument(word);
  if ('x' in target) throw new AgentToolsCommandError(`this act takes a ref or a selector, not a point ("${word}")`);
  return target;
}

const HISTORY_STEPS: ReadonlySet<string> = new Set(['back', 'forward', 'reload']);

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
    .option('--ask [message]', ASK_HELP)
    .action(
      async (name: string, command: string[], options: SessionOption & { folder?: string; ask?: string | true }) => {
        const text = joined(command);
        await call(
          {
            tool: 'terminal.open',
            name,
            ...(options.folder === undefined ? {} : { folder: options.folder }),
            ...(text === undefined ? {} : { command: text }),
            ...(options.ask === undefined ? {} : { askOwner: options.ask }),
          },
          options,
        );
      },
    );

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

  verb('ask', 'hand a terminal to the owner: their tab comes forward with “Your turn here”')
    .argument('<name>', 'the terminal’s name or id')
    .argument('[message...]', 'what the owner should do there; never a secret')
    .action(async (name: string, message: string[], options: SessionOption) => {
      const text = joined(message);
      await call({ tool: 'terminal.ask_owner', name, ...(text === undefined ? {} : { message: text }) }, options);
    });

  registerControlVerbs('terminal', verb, run, sessionOf);
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
    .option('--incognito', 'a throwaway page with its own cookies, shared with nothing; gone when closed')
    .option('--ask [message]', ASK_HELP)
    .action(
      async (
        name: string,
        url: string | undefined,
        options: SessionOption & { incognito?: boolean; ask?: string | true },
      ) => {
        await call(
          {
            tool: 'browser.open',
            name,
            ...(url === undefined ? {} : { url }),
            ...(options.incognito === true ? { incognito: true } : {}),
            ...(options.ask === undefined ? {} : { askOwner: options.ask }),
          },
          options,
        );
      },
    );

  verb('navigate', 'load a URL in a page, or go back, forward or reload')
    .argument('<name>', 'the page’s name or id')
    .argument('<url>', 'an http or https URL, or back, forward or reload')
    .action(async (name: string, url: string, options: SessionOption) => {
      await call(
        HISTORY_STEPS.has(url)
          ? { tool: 'browser.navigate', name, history: url as 'back' | 'forward' | 'reload' }
          : { tool: 'browser.navigate', name, url },
        options,
      );
    });

  verb('click', 'click an element in a page, or a point in it')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), a point (120,340), or a selector; shell-quote spaces')
    .option('--double', 'a double click')
    .option('--right', 'the right button')
    .action(async (name: string, target: string, options: SessionOption & { double?: boolean; right?: boolean }) => {
      await call(
        {
          tool: 'browser.click',
          name,
          ...targetArgument(target),
          ...(options.double === true ? { double: true } : {}),
          ...(options.right === true ? { button: 'right' } : {}),
        },
        options,
      );
    });

  verb('type', 'fill a field in a page; the text is never logged')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), or a selector')
    .argument('[text...]', 'text to type; use -- before text that starts with a dash')
    .option('--submit', 'press Enter after the text')
    .option('--slowly', 'type key by key, for a field that reacts to each keystroke')
    .action(
      async (
        name: string,
        target: string,
        text: string[],
        options: SessionOption & { submit?: boolean; slowly?: boolean },
      ) => {
        await call(
          {
            tool: 'browser.type',
            name,
            ...elementArgument(target),
            text: text.join(' '),
            ...(options.submit === true ? { submit: true } : {}),
            ...(options.slowly === true ? { slowly: true } : {}),
          },
          options,
        );
      },
    );

  verb('read', 'print a page’s visible text, its accessibility tree, or a snapshot with refs')
    .argument('<name>', 'the page’s name or id')
    .option('--a11y', 'the accessibility tree instead of the text')
    .option('--snapshot', 'the accessibility tree with a ref per element, which click and type accept')
    .option('--find <text>', 'with --snapshot: only the lines containing this text')
    .option('--selector <target>', 'read only this part of the page: a ref or a selector')
    .action(
      async (
        name: string,
        options: SessionOption & { a11y?: boolean; snapshot?: boolean; find?: string; selector?: string },
      ) => {
        await call(
          {
            tool: 'browser.read',
            name,
            ...(options.snapshot === true || options.find !== undefined
              ? { mode: 'snapshot' }
              : options.a11y === true
                ? { mode: 'a11y' }
                : {}),
            ...(options.find === undefined ? {} : { find: options.find }),
            ...(options.selector === undefined ? {} : elementArgument(options.selector)),
          },
          options,
        );
      },
    );

  verb('screenshot', 'save a screenshot of a page')
    .argument('<name>', 'the page’s name or id')
    .argument('<file>', 'where to write the image')
    .option('--full-page', 'the whole page, not only what is in view')
    .option('--jpeg', 'a JPEG instead of a PNG')
    .option('--of <target>', 'one element only: a ref or a selector')
    .action(
      async (
        name: string,
        file: string,
        options: SessionOption & { fullPage?: boolean; jpeg?: boolean; of?: string },
      ) => {
        await call(
          {
            tool: 'browser.screenshot',
            name,
            ...(options.of === undefined ? {} : elementArgument(options.of)),
            ...(options.fullPage === true ? { fullPage: true } : {}),
            ...(options.jpeg === true ? { format: 'jpeg' } : {}),
          },
          options,
          { screenshotTo: file },
        );
      },
    );

  verb('close', 'close a page')
    .argument('<name>', 'the page’s name or id')
    .action(async (name: string, options: SessionOption) => {
      await call({ tool: 'browser.close', name }, options);
    });

  verb('ask', 'hand a page to the owner: their tab comes forward with “Your turn here”')
    .argument('<name>', 'the page’s name or id')
    .argument('[message...]', 'what the owner should do there; never a secret')
    .action(async (name: string, message: string[], options: SessionOption) => {
      const text = joined(message);
      await call({ tool: 'browser.ask_owner', name, ...(text === undefined ? {} : { message: text }) }, options);
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
  verb('handback', `hand a ${noun} you took over back to the agent`)
    .argument('<name>', `the ${noun}’s name or id`)
    .action(async (name: string, options: SessionOption) => {
      await run({ kind: 'control', surface, action: 'handback', key: name, ...sessionOf(options) });
    });
  verb('handover', `let the agent use a ${noun} you opened (it may not otherwise)`)
    .argument('<name>', `the ${noun}’s name or id`)
    .action(async (name: string, options: SessionOption) => {
      await run({ kind: 'control', surface, action: 'handover', key: name, ...sessionOf(options) });
    });
  verb('control', `show which ${noun}s an agent is driving, taken over, or handed to it`).action(
    async (options: SessionOption) => {
      await run({ kind: 'view', surface, ...sessionOf(options) });
    },
  );
}
