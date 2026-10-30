import type { Command } from 'commander';
import { composeNoticeRequest } from './request.ts';
import type { NotifyPorts } from './ports.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP = 'target another session; an agent may notify only for its own (defaults to the current session)';

export interface NotifyOptions {
  readonly session?: string | undefined;
  readonly body?: string | undefined;
  readonly ping?: boolean | undefined;
}

interface AgendaModeOptions {
  readonly session?: string | undefined;
}

/** Which session this invocation acts on. */
function target(ports: NotifyPorts, session: string | undefined): string {
  const explicit = session?.trim() ?? '';
  if (explicit !== '') return explicit;
  const own = ports.ownSessionId?.trim() ?? '';
  if (own !== '') return own;
  throw new Error('no session id — run inside a session or pass --session <id>');
}

/**
 * `fy notify "<summary>" [--body "<md>"] [--ping]`: tell the owner one thing, as a plain notification in this
 * ferret's Inbox group. It only moves the Inbox badge; the phone buzzes only with `--ping`.
 */
export async function runNotify(ports: NotifyPorts, words: readonly string[], options: NotifyOptions): Promise<void> {
  const request = composeNoticeRequest(words, options);
  await ports.gateway.raise(target(ports, options.session), request);
  ports.out.success(
    `Sent. The owner sees it in this ferret's Inbox${options.ping === true ? ' and their phone buzzes' : ''}.`,
  );
}

/** `fy notify agenda [on|off]`: read, or switch, whether this ferret is told to keep an agenda. */
async function runAgendaMode(ports: NotifyPorts, state: string | undefined, options: AgendaModeOptions): Promise<void> {
  const choice = state?.trim().toLowerCase() ?? '';
  if (choice !== '' && choice !== 'on' && choice !== 'off') {
    throw new Error(`agenda mode is "on" or "off", not "${state?.trim() ?? ''}" — leave it out to read it`);
  }
  const sessionId = target(ports, options.session);
  if (choice === '') {
    const mode = await ports.gateway.agendaMode(sessionId);
    ports.out.success(`Agenda mode is ${mode.enabled ? 'on' : 'off'}. ${mode.note}`);
    return;
  }
  const mode = await ports.gateway.setAgendaMode(sessionId, choice === 'on');
  ports.out.success(`Agenda mode is now ${mode.enabled ? 'on' : 'off'}. ${mode.note}`);
}

const NOTIFY_HELP = `Notify only when the owner must act or must know — never for progress or finishing.
  <summary>   REQUIRED. One line, plain words: what the owner should know. It is the whole notification.
  --body      the longer reading behind it, as Markdown (optional)
  --ping      ALSO buzz the owner's phone. Rare: only when waiting for the Inbox would cost them something.

A notification only moves the Inbox badge; it clears when the owner reads it. To ask the owner to
decide something, keep an agenda item instead (agenda mode).

  fy notify agenda            show whether agenda mode is on for this ferret
  fy notify agenda on|off     switch it (a running ferret takes the change at its next launch)`;

/** Mounts `fy notify` onto the program. */
export function registerNotifyCommands(program: Command, ports: NotifyPorts): void {
  const notify = program
    .command('notify')
    .description("tell the owner one thing: a plain notification in this ferret's Inbox")
    .argument('[summary...]', 'one line saying what the owner should know')
    .option('--body <markdown>', 'the longer reading behind the summary, as Markdown')
    .option('--ping', "also buzz the owner's phone")
    .option(SESSION_FLAG, SESSION_HELP)
    .addHelpText('after', `\n${NOTIFY_HELP}`)
    .action(async (words: string[], _flags: unknown, command: Command) => {
      await runNotify(ports, words, command.opts<NotifyOptions>());
    });

  notify
    .command('agenda')
    .description('show or switch agenda mode for this ferret')
    .argument('[state]', 'on or off; leave out to read it')
    .option(SESSION_FLAG, SESSION_HELP)
    .action(async (state: string | undefined, _flags: unknown, command: Command) => {
      await runAgendaMode(ports, state, {
        ...notify.opts<AgendaModeOptions>(),
        ...command.opts<AgendaModeOptions>(),
      });
    });
}
