import type { IFyApiClient, SessionAgendaMode } from '@ferretry/protocol';
import type { NoticeRequest } from './request.ts';

/** Presentation port for `fy notify`: failures travel as thrown errors, the composition root words them. */
export interface INotifyOutput {
  success(message: string): void;
}

/** The daemon calls `fy notify` needs; the controller never sees a URL or a status code. */
export interface INotifyGateway {
  /** Raise one plain notification on the session's board. */
  raise(sessionId: string, request: NoticeRequest): Promise<void>;
  /** Whether the session's ferret is told to keep an agenda, as the daemon reads it now. */
  agendaMode(sessionId: string): Promise<SessionAgendaMode>;
  /** Switch the session's agenda mode; the daemon says what that does to a running ferret. */
  setAgendaMode(sessionId: string, enabled: boolean): Promise<SessionAgendaMode>;
}

/** The only client capability the notify gateway consumes. */
export type NotifyApiClient = Pick<IFyApiClient, 'request'>;

/** Everything a notify run needs besides its words and flags. */
export interface NotifyPorts {
  readonly gateway: INotifyGateway;
  readonly out: INotifyOutput;
  /** `FY_SESSION_ID`: the ferret this CLI runs inside, absent at the person's own shell. */
  readonly ownSessionId: string | undefined;
}
