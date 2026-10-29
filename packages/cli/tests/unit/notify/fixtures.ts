import type { SessionAgendaMode } from '@ferretry/protocol';
import type { INotifyGateway, INotifyOutput, NotifyPorts } from '../../../src/lib/notify/ports';
import type { NoticeRequest } from '../../../src/lib/notify/request';

export const SESSION = 'ms8kkfyd-95b7037e';

export class CapturingOutput implements INotifyOutput {
  readonly messages: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }
}

/** Records every call; `fail` makes each one reject the way the client does when the daemon refuses. */
export class RecordingNotifyGateway implements INotifyGateway {
  readonly raised: Array<{ sessionId: string; request: NoticeRequest }> = [];
  readonly read: string[] = [];
  readonly switched: Array<{ sessionId: string; enabled: boolean }> = [];

  constructor(
    private enabled = false,
    private readonly fail?: Error,
  ) {}

  raise(sessionId: string, request: NoticeRequest): Promise<void> {
    this.raised.push({ sessionId, request });
    return this.fail === undefined ? Promise.resolve() : Promise.reject(this.fail);
  }

  agendaMode(sessionId: string): Promise<SessionAgendaMode> {
    this.read.push(sessionId);
    return this.fail === undefined ? Promise.resolve(this.mode()) : Promise.reject(this.fail);
  }

  setAgendaMode(sessionId: string, enabled: boolean): Promise<SessionAgendaMode> {
    this.switched.push({ sessionId, enabled });
    this.enabled = enabled;
    return this.fail === undefined ? Promise.resolve(this.mode()) : Promise.reject(this.fail);
  }

  private mode(): SessionAgendaMode {
    return {
      enabled: this.enabled,
      restartRequired: true,
      note: this.enabled
        ? 'It is told to keep an agenda at its next launch.'
        : 'It keeps no agenda from its next launch.',
    };
  }
}

export function ports(gateway: INotifyGateway, out: INotifyOutput, ownSessionId?: string): NotifyPorts {
  return { gateway, out, ownSessionId };
}
