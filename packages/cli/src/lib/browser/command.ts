import type { Command } from 'commander';
import type { IBrowserRunner } from './controller.ts';
import { optionalText, parseLoginMinutes, parseViewport, requireText } from './parse.ts';
import type { BrowserCommand } from './types.ts';

interface SessionOption {
  readonly session?: string;
}

const SESSION_HELP = 'target another session (an agent is always restricted to its own, server-side)';

/**
 * Registers the `browser` group.
 *
 * `--session` is accepted both before and after the verb, and the one written on the verb wins;
 * commander stores an option written before a subcommand on the parent, so reading only one of the
 * two would silently drop the operator's choice.
 */
export function registerBrowserCommands(program: Command, controller: IBrowserRunner): void {
  const browser = program
    .command('browser')
    .description("drive this session's shared browser and the human sign-in window")
    .option('-s, --session <id>', SESSION_HELP);

  const sessionOf = (options: SessionOption): SessionOption => {
    const session = options.session?.trim() || browser.opts<SessionOption>().session?.trim();
    return session ? { session } : {};
  };

  const verb = (name: string, description: string, aliases: readonly string[] = []): Command => {
    const command = browser.command(name).description(description).option('-s, --session <id>', SESSION_HELP);
    for (const alias of aliases) command.alias(alias);
    return command;
  };

  const dispatch = (build: (options: SessionOption) => BrowserCommand) => async (options: SessionOption) => {
    await controller.run(build(sessionOf(options)));
  };

  verb('status', 'show lifecycle, tabs, viewport, viewers, and last actor') //
    .action(dispatch(session => ({ command: 'status', ...session })));
  verb('start', 'start the browser without navigating') //
    .action(dispatch(session => ({ command: 'start', ...session })));
  verb('stop', 'stop the browser processes; the persistent login profile remains', ['close']) //
    .action(dispatch(session => ({ command: 'stop', ...session })));
  verb('back', 'navigate back').action(dispatch(session => ({ command: 'back', ...session })));
  verb('forward', 'navigate forward').action(dispatch(session => ({ command: 'forward', ...session })));
  verb('reload', 'reload the current page').action(dispatch(session => ({ command: 'reload', ...session })));

  verb('open', "start or reuse this session's browser, optionally navigating")
    .argument('[url]', 'URL to open')
    .action(async (url: string | undefined, options: SessionOption) => {
      const target = optionalText(url);
      await controller.run({ command: 'open', ...(target ? { url: target } : {}), ...sessionOf(options) });
    });

  verb('new-page', 'create and activate a browser tab, optionally navigating')
    .argument('[url]', 'URL to open in the new tab')
    .action(async (url: string | undefined, options: SessionOption) => {
      const target = optionalText(url);
      await controller.run({ command: 'new-page', ...(target ? { url: target } : {}), ...sessionOf(options) });
    });

  verb('activate-page', 'make a browser tab active')
    .argument('<pageId>', 'tab to activate')
    .action(async (pageId: string, options: SessionOption) => {
      await controller.run({ command: 'activate-page', pageId: requireText(pageId, 'page id'), ...sessionOf(options) });
    });

  verb('close-page', 'close a browser tab')
    .argument('<pageId>', 'tab to close')
    .action(async (pageId: string, options: SessionOption) => {
      await controller.run({ command: 'close-page', pageId: requireText(pageId, 'page id'), ...sessionOf(options) });
    });

  verb('navigate', 'navigate the shared browser', ['goto'])
    .argument('<url>', 'URL to navigate to')
    .action(async (url: string, options: SessionOption) => {
      await controller.run({ command: 'navigate', url: requireText(url, 'URL'), ...sessionOf(options) });
    });

  verb('click', 'click a selector')
    .argument('<selector>', 'selector to click; shell-quote selectors containing spaces')
    .action(async (selector: string, options: SessionOption) => {
      await controller.run({ command: 'click', selector: requireText(selector, 'selector'), ...sessionOf(options) });
    });

  verb('type', 'fill a selector; the text is never logged')
    .argument('<selector>', 'selector to fill')
    .argument('[text...]', 'text to type; use -- before text that starts with a dash')
    .action(async (selector: string, text: string[], options: SessionOption) => {
      const command: BrowserCommand = {
        command: 'type',
        selector: requireText(selector, 'selector'),
        text: text.join(' '),
        ...sessionOf(options),
      };
      await controller.run(command);
    });

  verb('read', 'print visible text (the whole body by default)')
    .argument('[selector]', 'selector to read')
    .action(async (selector: string | undefined, options: SessionOption) => {
      const target = optionalText(selector);
      await controller.run({ command: 'read', ...(target ? { selector: target } : {}), ...sessionOf(options) });
    });

  verb('screenshot', 'save an explicit viewport screenshot')
    .argument('<file>', 'path to write the PNG to')
    .action(async (file: string, options: SessionOption) => {
      await controller.run({ command: 'screenshot', output: requireText(file, 'output file'), ...sessionOf(options) });
    });

  verb('resize', 'resize the browser viewport')
    .argument('<width>', 'viewport width in pixels')
    .argument('<height>', 'viewport height in pixels')
    .action(async (width: string, height: string, options: SessionOption) => {
      await controller.run({ command: 'resize', ...parseViewport(width, height), ...sessionOf(options) });
    });

  registerLoginCommands(browser, controller);
}

/**
 * The sign-in window is daemon-global and human-admin only: it is about the one shared profile, not
 * about any session, so these verbs deliberately take no `--session`.
 */
function registerLoginCommands(browser: Command, controller: IBrowserRunner): void {
  const login = browser
    .command('login')
    .description('the human sign-in window; daemon-global, reachable only over an SSH tunnel');

  login
    .command('status')
    .description('show its state, deadline, and connection details')
    .action(async () => {
      await controller.run({ command: 'login', action: 'status' });
    });

  login
    .command('start')
    .description('open it; agents lose the browser while it is open')
    .option('-m, --minutes <n>', 'how long to keep it open; the daemon owns the maximum')
    .action(async (options: { minutes?: string }) => {
      const minutes = options.minutes === undefined ? undefined : parseLoginMinutes(options.minutes);
      await controller.run({ command: 'login', action: 'start', ...(minutes === undefined ? {} : { minutes }) });
    });

  login
    .command('confirm')
    .description('mark the profile signed in and leave the window open')
    .action(async () => {
      await controller.run({ command: 'login', action: 'confirm' });
    });

  login
    .command('stop')
    .alias('close')
    .description('close it')
    .option('--primed', 'also mark the profile signed in')
    .action(async (options: { primed?: boolean }) => {
      await controller.run({ command: 'login', action: 'stop', ...(options.primed ? { primed: true } : {}) });
    });
}
