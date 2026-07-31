import type { SendDisposition } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { SessionEnvironment } from './ports.ts';

/** The `send` flags, already parsed out of argv by the composition root. */
export interface SendFlags {
  /** The message typed as arguments. */
  readonly message?: string;
  /** Text already read from `--message-file`, appended after the typed message. */
  readonly fileMessage?: string;
  readonly attachmentPaths?: readonly string[];
  readonly now?: boolean;
  readonly ask?: boolean;
  readonly until?: string;
}

export interface SendPlan {
  readonly message: string;
  readonly attachmentPaths: readonly string[];
  readonly now: boolean;
  readonly replyExpected: boolean;
  /** Set when the caller asked to be parked: the session id to park and the deadline, if any. */
  readonly park?: { readonly callerSessionId: string; readonly until?: string };
}

/**
 * Validates and composes a send before anything is uploaded or sent.
 *
 * The order matters: the source uploaded every attachment first and only then discovered that
 * `--ask` was illegal outside a session, leaving orphaned uploads attached to a message it never
 * sent. Everything checkable is checked here, before the first upload.
 */
export function planSend(flags: SendFlags, environment: SessionEnvironment): SendPlan {
  const message = [flags.message?.trim() ?? '', flags.fileMessage?.trim() ?? '']
    .filter(part => part !== '')
    .join('\n\n');
  const attachmentPaths = [...(flags.attachmentPaths ?? [])];
  // The wire contract requires a message: an attachment with no words is a file the agent was never
  // told what to do with.
  if (message === '')
    throw new SessionCommandError('provide a message (arguments and/or --message-file) to send with the attachments');

  const caller = environment.callerSessionId?.trim();
  if (flags.ask === true && (caller === undefined || caller === ''))
    throw new SessionCommandError(
      '--ask parks the calling session, so it only works from inside a session (FY_SESSION_ID is unset)',
    );
  if (flags.until !== undefined && flags.ask !== true) throw new SessionCommandError('--until applies to `send --ask`');

  return {
    message,
    attachmentPaths,
    now: flags.now === true,
    replyExpected: flags.ask === true,
    ...(flags.ask === true && caller !== undefined && caller !== ''
      ? { park: { callerSessionId: caller, ...(flags.until === undefined ? {} : { until: flags.until }) } }
      : {}),
  };
}

const DISPOSITION_NOTES: Readonly<Record<SendDisposition, string>> = {
  delivered: 'delivered',
  queued: "queued in the agent's own queue (it auto-submits at the turn boundary)",
  revived: 'revived the session with the message',
  'queued-for-revive': 'queued durably in the session inbox; an explicit resume remains available',
};

/** What actually happened to the message, as the daemon reported it. */
export function describeDisposition(disposition: SendDisposition): string {
  return DISPOSITION_NOTES[disposition];
}

/** The stderr note that follows a successful park, or the refusal when no agent received it. */
export function describePark(input: { disposition: SendDisposition; peer: string; until?: string }): {
  readonly parked: boolean;
  readonly note: string;
} {
  // A park is only honest when something is running to answer it: a message merely queued for a
  // revive has no live peer, so the caller would sit blocked on a reply nobody was asked for.
  if (input.disposition === 'queued-for-revive')
    return {
      parked: false,
      note: 'the recipient was not revived, so this session was not parked — no running agent received the message',
    };
  const deadline =
    input.until === undefined ? ' (open-ended; the 4h backstop still applies)' : ` (until ${input.until})`;
  return {
    parked: true,
    note: `parked awaiting a reply from ${input.peer}${deadline} — the daemon wakes this session when the reply arrives`,
  };
}
