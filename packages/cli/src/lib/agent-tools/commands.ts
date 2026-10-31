import { AGENT_TOOL_DEFAULT_WAIT_MS, ATTACHMENT_ID_PATTERN, BROWSER_REF_PATTERN } from '@ferretry/protocol';
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

/** `1280x800` as a viewport. */
function viewportArgument(value: string): { readonly width: number; readonly height: number } {
  const match = /^(\d+)x(\d+)$/iu.exec(value.trim());
  if (match === null) throw new AgentToolsCommandError(`--viewport must be WIDTHxHEIGHT, like 390x844, not "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `52.5,13.4` or `52.5,13.4,50` (latitude, longitude, accuracy in metres) as a position. */
function geolocationArgument(value: string): {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
} {
  const parts = value.split(',').map(part => part.trim());
  const numbers = parts.map(part => (part === '' ? Number.NaN : Number(part)));
  if ((numbers.length !== 2 && numbers.length !== 3) || numbers.some(number => !Number.isFinite(number)))
    throw new AgentToolsCommandError(`--geolocation must be LAT,LON or LAT,LON,ACCURACY, not "${value}"`);
  const [latitude, longitude, accuracy] = numbers as [number, number, number | undefined];
  return { latitude, longitude, ...(accuracy === undefined ? {} : { accuracy }) };
}

/** A decimal number from the command line, or a plain refusal naming the option. */
function decimal(value: string, option: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed))
    throw new AgentToolsCommandError(`${option} must be a number, not "${value}"`);
  return parsed;
}

/** A number that may be negative or fractional: a scroll distance or a count of screens. */
function signedNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed))
    throw new AgentToolsCommandError(`${option} must be a number, not "${value}"`);
  return parsed;
}

/** A repeatable option that also takes a comma list: `--type xhr,fetch --type script`. */
const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== ''),
];
/** `--by dx,dy` as the scroll tool's deltas. */
function distanceArgument(value: string): { readonly deltaX: number; readonly deltaY: number } {
  const [x, y, ...rest] = value.split(',');
  if (x === undefined || y === undefined || rest.length > 0)
    throw new AgentToolsCommandError(`--by must be two numbers, dx,dy, not "${value}"`);
  return { deltaX: signedNumber(x, '--by'), deltaY: signedNumber(y, '--by') };
}

/** One end of a drag: a target's fields under `from…` or `to…`. */
function prefixed(prefix: 'from' | 'to', target: ReturnType<typeof targetArgument>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(target).map(([key, value]) => [`${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`, value]),
  );
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

  verb('hover', 'move the pointer over an element in a page, or a point in it')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), a point (120,340), or a selector')
    .action(async (name: string, target: string, options: SessionOption) => {
      await call({ tool: 'browser.hover', name, ...targetArgument(target) }, options);
    });

  verb('drag', 'drag from one element to another, or from one point to another')
    .argument('<name>', 'the page’s name or id')
    .argument('<from>', 'where it starts: a ref (e12), a point (120,340), or a selector')
    .argument('<to>', 'where it ends, the same kind of target')
    .option('--steps <n>', 'by points only: how many moves on the way (1 to 100)')
    .action(async (name: string, from: string, to: string, options: SessionOption & { steps?: string }) => {
      await call(
        {
          tool: 'browser.drag',
          name,
          ...prefixed('from', targetArgument(from)),
          ...prefixed('to', targetArgument(to)),
          ...(options.steps === undefined ? {} : { steps: wholeNumber(options.steps, '--steps') }),
        },
        options,
      );
    });

  verb('press', 'press keys in a page, e.g. Enter, ArrowDown, Control+Shift+K; never a secret')
    .argument('<name>', 'the page’s name or id')
    .argument('<keys...>', 'one to 32 keys, pressed in order')
    .option('--on <target>', 'focus this element first: a ref or a selector')
    .action(async (name: string, keys: string[], options: SessionOption & { on?: string }) => {
      await call(
        {
          tool: 'browser.press',
          name,
          keys,
          ...(options.on === undefined ? {} : elementArgument(options.on)),
        },
        options,
      );
    });

  verb('scroll', 'scroll a page: to an element, to a text, by pixels, or by screens')
    .argument('<name>', 'the page’s name or id')
    .option('--to <target>', 'scroll this element into view: a ref or a selector')
    .option('--text <text>', 'scroll to the first place this text shows')
    .option('--by <dx,dy>', 'scroll by this many pixels, e.g. 0,600 or 0,-600')
    .option('--pages <n>', 'scroll by screens: 1 is one down, -1 one up')
    .action(
      async (name: string, options: SessionOption & { to?: string; text?: string; by?: string; pages?: string }) => {
        await call(
          {
            tool: 'browser.scroll',
            name,
            ...(options.to === undefined ? {} : elementArgument(options.to)),
            ...(options.text === undefined ? {} : { text: options.text }),
            ...(options.by === undefined ? {} : distanceArgument(options.by)),
            ...(options.pages === undefined ? {} : { pages: signedNumber(options.pages, '--pages') }),
          },
          options,
        );
      },
    );

  verb('select', 'choose options of a select element, by value or label')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), or a selector')
    .argument('<values...>', 'the options to choose')
    .action(async (name: string, target: string, values: string[], options: SessionOption) => {
      await call({ tool: 'browser.select', name, ...elementArgument(target), values }, options);
    });

  verb('check', 'tick a checkbox or radio button, or untick it with --off')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), or a selector')
    .option('--off', 'untick instead of tick')
    .action(async (name: string, target: string, options: SessionOption & { off?: boolean }) => {
      await call({ tool: 'browser.check', name, ...elementArgument(target), checked: options.off !== true }, options);
    });

  verb('highlight', 'outline an element so the person watching sees it, or remove the outline with --clear')
    .argument('<name>', 'the page’s name or id')
    .argument('[target]', 'a ref from read --snapshot (e12), or a selector')
    .option('--clear', 'remove the outline')
    .action(async (name: string, target: string | undefined, options: SessionOption & { clear?: boolean }) => {
      await call(
        {
          tool: 'browser.highlight',
          name,
          ...(target === undefined ? {} : elementArgument(target)),
          ...(options.clear === true ? { clear: true } : {}),
        },
        options,
      );
    });

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

  verb('dialog', 'answer the dialog a page is waiting on (alert, confirm, prompt)')
    .argument('<name>', 'the page’s name or id')
    .argument('<action>', 'accept or dismiss')
    .option('--text <answer>', 'a prompt’s answer; only with accept')
    .action(async (name: string, action: string, options: SessionOption & { text?: string }) => {
      await call(
        { tool: 'browser.dialog', name, action, ...(options.text === undefined ? {} : { promptText: options.text }) },
        options,
      );
    });

  verb('tabs', 'list the pages and their popups, or adopt a popup under a name')
    .argument('[action]', 'list (the default) or adopt', 'list')
    .argument('[id]', 'adopt: the popup’s id from the list')
    .argument('[as]', 'adopt: the name to give it')
    .action(async (action: string, id: string | undefined, as: string | undefined, options: SessionOption) => {
      await call(
        { tool: 'browser.tabs', action, ...(id === undefined ? {} : { id }), ...(as === undefined ? {} : { as }) },
        options,
      );
    });

  verb('wait', 'wait for an element, text, an address, a load state or a time; exits 1 on timeout')
    .argument('<name>', 'the page’s name or id')
    .option('--ref <ref>', 'an element ref from read --snapshot')
    .option('--selector <selector>', 'an element selector')
    .option('--state <state>', 'with --ref or --selector: visible (the default), hidden, attached or detached')
    .option('--text <text>', 'wait until this text is on the page')
    .option('--text-gone <text>', 'wait until this text is gone')
    .option('--url <part>', 'wait until the address contains this')
    .option('--load <state>', 'wait for load, domcontentloaded or networkidle')
    .option('--time <ms>', 'just wait this many milliseconds (up to 25000)')
    .option('-t, --timeout <ms>', 'how long to wait in all', String(AGENT_TOOL_DEFAULT_WAIT_MS))
    .action(
      async (
        name: string,
        options: SessionOption & {
          ref?: string;
          selector?: string;
          state?: string;
          text?: string;
          textGone?: string;
          url?: string;
          load?: string;
          time?: string;
          timeout: string;
        },
      ) => {
        await run({
          kind: 'browser-wait',
          call: {
            name,
            ...(options.ref === undefined ? {} : { ref: options.ref }),
            ...(options.selector === undefined ? {} : { selector: options.selector }),
            ...(options.state === undefined ? {} : { state: options.state }),
            ...(options.text === undefined ? {} : { text: options.text }),
            ...(options.textGone === undefined ? {} : { textGone: options.textGone }),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.load === undefined ? {} : { load: options.load }),
            ...(options.time === undefined ? {} : { time: wholeNumber(options.time, '--time') }),
          },
          totalMs: wholeNumber(options.timeout, '--timeout'),
          ...sessionOf(options),
        });
      },
    );

  verb('console', 'print a page’s recent console messages and errors, numbered')
    .argument('<name>', 'the page’s name or id')
    .option('--level <level>', 'this level and worse: error, warning, info, log or debug')
    .option('--since <n>', 'only entries after this number')
    .option('--limit <n>', 'at most this many, newest kept (100 by default)')
    .action(async (name: string, options: SessionOption & { level?: string; since?: string; limit?: string }) => {
      await call(
        {
          tool: 'browser.console',
          name,
          ...(options.level === undefined ? {} : { level: options.level }),
          ...(options.since === undefined ? {} : { since: wholeNumber(options.since, '--since') }),
          ...(options.limit === undefined ? {} : { limit: wholeNumber(options.limit, '--limit') }),
        },
        options,
      );
    });

  verb('network', 'list a page’s recent requests, or show one by its id (r12)')
    .argument('<name>', 'the page’s name or id')
    .argument('[request]', 'a request id from the list: show it, with its response body if it is text')
    .option('--filter <text>', 'list: only URLs containing this')
    .option(
      '--type <kind>',
      'list: only these kinds (xhr, fetch, document, script, …); repeat or comma-separate',
      collect,
    )
    .action(
      async (
        name: string,
        request: string | undefined,
        options: SessionOption & { filter?: string; type?: string[] },
      ) => {
        await call(
          {
            tool: 'browser.network',
            name,
            action: request === undefined ? 'list' : 'get',
            ...(request === undefined ? {} : { id: request }),
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.type === undefined ? {} : { types: options.type }),
          },
          options,
        );
      },
    );

  verb('emulate', 'make a page look like another device or setting; --reset puts it back')
    .argument('<name>', 'the page’s name or id')
    .option('--viewport <WxH>', 'the viewport in CSS pixels, like 390x844')
    .option('--color-scheme <scheme>', 'light, dark or no-preference')
    .option('--reduced-motion <value>', 'reduce or no-preference')
    .option('--forced-colors <value>', 'active or none')
    .option('--contrast <value>', 'more, less, custom or no-preference')
    .option('--print', 'lay the page out as for print')
    .option('--geolocation <lat,lon[,accuracy]>', 'a position, accuracy in metres')
    .option('--locale <tag>', 'a language tag, like en-US')
    .option('--timezone <name>', 'an IANA timezone, like Europe/Berlin')
    .option('--cpu-throttle <rate>', 'slow the CPU down this many times (1 is none)')
    .option('--offline', 'cut the network')
    .option('--latency <ms>', 'add this much network delay')
    .option('--throughput <kbps>', 'limit the network to this many kilobits per second')
    .option('--permission <name>', 'grant a permission to the page’s site; repeat or comma-separate', collect)
    .option('--reset', 'put everything back as it was')
    .action(
      async (
        name: string,
        options: SessionOption & {
          viewport?: string;
          colorScheme?: string;
          reducedMotion?: string;
          forcedColors?: string;
          contrast?: string;
          print?: boolean;
          geolocation?: string;
          locale?: string;
          timezone?: string;
          cpuThrottle?: string;
          offline?: boolean;
          latency?: string;
          throughput?: string;
          permission?: string[];
          reset?: boolean;
        },
      ) => {
        const media = {
          ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
          ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
          ...(options.forcedColors === undefined ? {} : { forcedColors: options.forcedColors }),
          ...(options.contrast === undefined ? {} : { contrast: options.contrast }),
          ...(options.print === true ? { print: true } : {}),
        };
        const network = {
          ...(options.offline === true ? { offline: true } : {}),
          ...(options.latency === undefined ? {} : { latency: wholeNumber(options.latency, '--latency') }),
          ...(options.throughput === undefined ? {} : { throughput: wholeNumber(options.throughput, '--throughput') }),
        };
        await call(
          {
            tool: 'browser.emulate',
            name,
            ...(options.viewport === undefined ? {} : { viewport: viewportArgument(options.viewport) }),
            ...(Object.keys(media).length === 0 ? {} : { media }),
            ...(options.geolocation === undefined ? {} : { geolocation: geolocationArgument(options.geolocation) }),
            ...(options.locale === undefined ? {} : { locale: options.locale }),
            ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
            ...(options.cpuThrottle === undefined
              ? {}
              : { cpuThrottle: decimal(options.cpuThrottle, '--cpu-throttle') }),
            ...(Object.keys(network).length === 0 ? {} : { network }),
            ...(options.permission === undefined ? {} : { permissions: options.permission }),
            ...(options.reset === true ? { reset: true } : {}),
          },
          options,
        );
      },
    );

  verb('upload', 'give a page files: into a file input, or its file picker; needs the files switch')
    .argument('<name>', 'the page’s name or id')
    .argument('<target>', 'a ref from read --snapshot (e12), or a selector')
    .argument('<files...>', 'paths in the session’s folder, or att_… attachment ids')
    .option('--drop', 'drop them on a dropzone that has no file input')
    .action(async (name: string, target: string, files: string[], options: SessionOption & { drop?: boolean }) => {
      await call(
        {
          tool: 'browser.upload',
          name,
          ...elementArgument(target),
          files: files.map(file => (ATTACHMENT_ID_PATTERN.test(file) ? { attachment: file } : file)),
          ...(options.drop === true ? { mode: 'drop' } : {}),
        },
        options,
      );
    });

  verb('download', 'save a file the page downloaded into the session’s folder; needs the files switch')
    .argument('<name>', 'the page’s name or id')
    .argument('[saveAs]', 'where to save it, inside the session’s folder; downloads/<its name> when absent')
    .option('--id <id>', 'which download (dl-1, from the act that started it); the latest when absent')
    .option('--overwrite', 'replace a file that is already there')
    .action(
      async (
        name: string,
        saveAs: string | undefined,
        options: SessionOption & { id?: string; overwrite?: boolean },
      ) => {
        await call(
          {
            tool: 'browser.download',
            name,
            ...(options.id === undefined ? {} : { id: options.id }),
            ...(saveAs === undefined ? {} : { saveAs }),
            ...(options.overwrite === true ? { overwrite: true } : {}),
          },
          options,
        );
      },
    );

  verb('pdf', 'print a page to a PDF in the session’s folder (headless browser only); needs the files switch')
    .argument('<name>', 'the page’s name or id')
    .argument('[saveAs]', 'where to save it, inside the session’s folder')
    .option('--overwrite', 'replace a file that is already there')
    .action(async (name: string, saveAs: string | undefined, options: SessionOption & { overwrite?: boolean }) => {
      await call(
        {
          tool: 'browser.pdf',
          name,
          ...(saveAs === undefined ? {} : { saveAs }),
          ...(options.overwrite === true ? { overwrite: true } : {}),
        },
        options,
      );
    });

  verb('eval', 'run your own JavaScript in a page, in a world of its own; needs the owner’s Page scripts switch')
    .argument('<name>', 'the page’s name or id')
    .argument('<function>', 'a function expression: "() => document.title", or "(element) => …" with --of')
    .option('--of <target>', 'hand the function one element: a ref or a selector')
    .option('--timeout <ms>', 'stop it after this long (up to 10000)')
    .action(async (name: string, source: string, options: SessionOption & { of?: string; timeout?: string }) => {
      await call(
        {
          tool: 'browser.eval',
          name,
          function: source,
          ...(options.of === undefined ? {} : elementArgument(options.of)),
          ...(options.timeout === undefined ? {} : { timeoutMs: wholeNumber(options.timeout, '--timeout') }),
        },
        options,
      );
    });

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
