import {
  AgendaActionRequestSchema,
  AgendaListSnapshotSchema,
  AgendaReadItemSchema,
  isMachineAgendaId,
  type AgendaActionRequest,
  type AgendaListSnapshot,
  type AgendaReadItem,
} from '@ferretry/core-asks/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { IAgendaGateway } from './ports.ts';

/**
 * Speaks the agenda routes through the plugin client (§2.3): the ferret's own board and the machine ledger.
 *
 * Both ends are parsed against the contract's schemas, so a daemon answering with an error envelope is a stated
 * failure rather than a crash inside rendering. WHO is acting is the credential the shell presents (a ferret's own
 * `fys_` bearer, or the owner's), never a header this CLI sets, so nothing here can raise an item as someone else.
 */
export class RouteAgendaGateway implements IAgendaGateway {
  constructor(
    private readonly client: PluginClient,
    /** `FY_SESSION_ID`: the ferret this CLI runs inside, absent at the person's own shell. */
    private readonly ownFerretId: string | undefined,
  ) {}

  async snapshot(ferretId: string): Promise<AgendaListSnapshot> {
    this.#requireMachineOwner(ferretId);
    const answer = isMachineAgendaId(ferretId)
      ? await this.client.call('GET /v1/machine/agenda')
      : await this.client.call('GET /v1/ferrets/:ferretId/agenda', { params: { ferretId } });
    return AgendaListSnapshotSchema.parse(answer);
  }

  async readItem(ferretId: string, id: string): Promise<AgendaReadItem> {
    this.#requireMachineOwner(ferretId);
    const answer = isMachineAgendaId(ferretId)
      ? await this.client.call('GET /v1/machine/agenda/:id', { params: { id } })
      : await this.client.call('GET /v1/ferrets/:ferretId/agenda/:id', { params: { ferretId, id } });
    const item = AgendaReadItemSchema.parse(answer);
    if (item.id !== id) throw new Error('daemon returned another agenda item');
    return item;
  }

  async apply(ferretId: string, request: AgendaActionRequest): Promise<AgendaListSnapshot> {
    this.#requireMachineOwner(ferretId);
    const body = AgendaActionRequestSchema.parse(request);
    const answer = isMachineAgendaId(ferretId)
      ? await this.client.call('POST /v1/machine/agenda', { body })
      : await this.client.call('POST /v1/ferrets/:ferretId/agenda', { params: { ferretId }, body });
    return AgendaListSnapshotSchema.parse(answer);
  }

  async sendReplies(ferretId: string): Promise<AgendaListSnapshot> {
    this.#requireMachineOwner(ferretId);
    if (isMachineAgendaId(ferretId)) throw new Error('the machine agenda has no held replies to send');
    return AgendaListSnapshotSchema.parse(
      await this.client.call('POST /v1/ferrets/:ferretId/agenda/replies', { params: { ferretId }, body: {} }),
    );
  }

  #requireMachineOwner(ferretId: string): void {
    if (isMachineAgendaId(ferretId) && this.ownFerretId !== undefined)
      throw new Error("the machine agenda is the owner's; ask them");
  }
}
