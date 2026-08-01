import { SignalKindSchema, type SignalOptions } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { ISessionApi, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Flags accepted by `fy signal`. */
export interface SignalCommandOptions {
  readonly session?: string;
  readonly until?: string;
  readonly on?: string;
  readonly peer?: string;
  readonly json?: boolean;
}

/** Records the calling teammate's lifecycle state through the daemon. */
export class SignalSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
  ) {}

  async execute(kindValue: string, messageValue: string | undefined, flags: SignalCommandOptions): Promise<void> {
    const parsed = SignalKindSchema.safeParse(kindValue);
    if (!parsed.success) throw new SessionCommandError('kind must be one of done, help, waiting, working');
    const kind = parsed.data;
    const id = optionalText(flags.session) ?? optionalText(this.environment.callerSessionId);
    if (id === undefined)
      throw new SessionCommandError('no session id; pass --session or run inside a session (FY_SESSION_ID is unset)');
    const message = optionalText(messageValue);
    if (kind === 'help' && message === undefined) throw new SessionCommandError('signal help requires a message');
    if (kind !== 'waiting' && (flags.until !== undefined || flags.on !== undefined || flags.peer !== undefined)) {
      throw new SessionCommandError('--until/--on/--peer apply to `signal waiting`');
    }

    const options: SignalOptions = {
      ...(optionalText(flags.until) === undefined ? {} : { until: optionalText(flags.until) }),
      ...(optionalText(flags.on) === undefined ? {} : { condition: optionalText(flags.on) }),
      ...(optionalText(flags.peer) === undefined ? {} : { peer: optionalText(flags.peer) }),
    };
    const view = await this.api.signal(id, kind, message, options);
    if (kind === 'waiting' && view.state.waiting === undefined) {
      throw new Error('daemon accepted waiting but returned no declared-wait state');
    }
    if (flags.json === true) {
      this.presenter.json(view);
      return;
    }
    this.presenter.lines([kind === 'waiting' ? waitingNote(view) : `${kind} signal recorded`]);
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function waitingNote(view: Awaited<ReturnType<ISessionApi['signal']>>): string {
  const waiting = view.state.waiting;
  if (waiting === undefined) throw new Error('daemon returned no declared-wait state');
  const peer = waiting.peerName ?? waiting.peer;
  const subject = peer === undefined ? waiting.condition : `a reply from ${peer}`;
  return `waiting recorded${subject === undefined ? '' : ` for ${subject}`}${
    waiting.until === undefined ? ' (open-ended)' : ` until ${waiting.until}`
  } — idle-kill and the turn ceiling are suspended while it holds${
    peer === undefined ? '' : '; the daemon wakes this session as soon as that peer sends back'
  }`;
}
