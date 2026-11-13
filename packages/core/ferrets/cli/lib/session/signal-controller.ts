import { SessionCommandError } from './errors.ts';
import {
  type ISessionApi,
  SIGNAL_KINDS,
  type SignalAnswer,
  type SignalKind,
  type SessionEnvironment,
  type SignalOptions,
} from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Flags accepted by `fy signal`. */
export interface SignalCommandOptions {
  readonly session?: string;
  readonly until?: string;
  readonly on?: string;
  readonly peer?: string;
  readonly json?: boolean;
}

const isKind = (value: string): value is SignalKind => (SIGNAL_KINDS as readonly string[]).includes(value);

/** Records the calling teammate's lifecycle state through the daemon. */
export class SignalSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
  ) {}

  async execute(kindValue: string, messageValue: string | undefined, flags: SignalCommandOptions): Promise<void> {
    if (!isKind(kindValue)) throw new SessionCommandError('kind must be one of done, help, waiting, working');
    const kind = kindValue;
    const id = optionalText(flags.session) ?? optionalText(this.environment.callerSessionId);
    if (id === undefined) throw new SessionCommandError('no ferret named; pass --session <ferret>');
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
    const answer = await this.api.signal(id, kind, message, options);
    if (kind === 'waiting' && answer.waiting === undefined) {
      throw new Error('daemon accepted waiting but returned no declared-wait state');
    }
    if (flags.json === true) {
      this.presenter.json(answer);
      return;
    }
    this.presenter.lines([kind === 'waiting' ? waitingNote(answer) : `${kind} signal recorded`]);
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function waitingNote(answer: SignalAnswer): string {
  const waiting = answer.waiting;
  if (waiting === undefined) throw new Error('daemon returned no declared-wait state');
  const peer = waiting.peerName ?? waiting.peer;
  const subject = peer === undefined ? waiting.condition : `a reply from ${peer}`;
  return `waiting recorded${subject === undefined ? '' : ` for ${subject}`}${
    waiting.until === undefined ? ' (open-ended)' : ` until ${waiting.until}`
  } — idle-kill and the turn ceiling are suspended while it holds${
    peer === undefined ? '' : '; the daemon wakes this ferret as soon as that peer sends back'
  }`;
}
