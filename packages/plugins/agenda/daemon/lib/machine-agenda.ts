import { AskIdSchema, type AsksApi, type AskBoardSnapshot } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { DaemonAgenda, DaemonAgendaAction } from '../../contract/index.ts';

export class MachineAgendaError extends Error {
  override readonly name = 'MachineAgendaError';
  constructor(
    readonly reason: 'invalid' | 'not-found',
    message: string,
  ) {
    super(message);
  }
}

/** The owner reads the full machine board and applies its four verbs through Asks. */
export class MachineAgendaView {
  constructor(
    private readonly asks: Pick<AsksApi, 'snapshots' | 'ownerAction'>,
    private readonly board: FerretId,
  ) {}

  async list(): Promise<AskBoardSnapshot> {
    const snapshot = (await this.asks.snapshots({ ferret: this.board }))[0];
    if (snapshot === undefined) throw new MachineAgendaError('not-found', 'agenda board not found');
    return snapshot;
  }

  async find(id: string): Promise<AskBoardSnapshot['items'][number]> {
    const { items, resolved } = await this.list();
    const found = [...items, ...resolved].find(item => item.id === id);
    if (found === undefined) throw new MachineAgendaError('not-found', 'agenda item not found');
    return found;
  }

  async act(action: DaemonAgendaAction): Promise<DaemonAgenda> {
    const id = AskIdSchema.safeParse(action.id);
    if (!id.success) throw new MachineAgendaError('invalid', 'that is not an ask id');
    const { id: _id, ...verb } = action;
    return await this.asks.ownerAction({ ...verb, ref: { ferret: this.board, id: id.data } });
  }
}
