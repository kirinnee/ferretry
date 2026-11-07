import { AskIdSchema, type AsksApi, type AskSummary } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { type DaemonAgenda, type DaemonAgendaAction } from '../../contract/index.ts';

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class MachineAgendaError extends Error {
  constructor(
    readonly reason: 'invalid' | 'not-found' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'MachineAgendaError';
  }
}

/**
 * The owner's view of the MACHINE AGENDA (docs/agenda.md § The machine agenda): notices that belong to no live ferret,
 * kept by Asks on the daemon's own board. This reads it and takes the owner's few verbs on it — dismiss (the app's
 * Clear) and resolve without a reply. Raising, editing and every other verb are the daemon's own and have no route here.
 *
 * Snooze and unsnooze are Asks' state (a parked ask) and its port has no verb for them yet, so they are refused in words
 * rather than pretended.
 */
export class MachineAgendaView {
  constructor(
    private readonly asks: Pick<AsksApi, 'open' | 'close'>,
    private readonly board: FerretId,
  ) {}

  async list(): Promise<DaemonAgenda> {
    const [asks, answered, closed] = await Promise.all([
      this.asks.open({ ferret: this.board, state: 'open' }),
      this.asks.open({ ferret: this.board, state: 'answered' }),
      this.asks.open({ ferret: this.board, state: 'closed' }),
    ]);
    return { asks: [...asks], resolved: [...answered, ...closed] };
  }

  async find(id: string): Promise<AskSummary> {
    const { asks, resolved } = await this.list();
    const found = [...asks, ...resolved].find(ask => ask.id === id);
    if (found === undefined) throw new MachineAgendaError('not-found', 'agenda item not found');
    return found;
  }

  async act(action: DaemonAgendaAction): Promise<DaemonAgenda> {
    if (action.action === 'snooze' || action.action === 'unsnooze')
      throw new MachineAgendaError(
        'unsupported',
        'snoozing a daemon notice is not available yet: Asks has no snooze on its port',
      );
    const id = AskIdSchema.safeParse(action.ask);
    if (!id.success) throw new MachineAgendaError('invalid', 'that is not an ask id');
    const open = (await this.asks.open({ ferret: this.board, state: 'open' })).find(ask => ask.id === id.data);
    if (open === undefined) throw new MachineAgendaError('not-found', 'agenda item not found');
    await this.asks.close({ ferret: this.board, id: id.data }, action.action === 'dismiss' ? 'dismissed' : 'answered');
    return await this.list();
  }
}
