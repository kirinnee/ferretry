import { BoardMergeGateResponseSchema, type IFyApiClient } from '@ferretry/protocol';
import type { IMergeGateGateway } from '../../lib/board/merge-gate';

/** `GET /v1/board/merge-gate?pr=<url>`: the one place `fy task merge-gate` knows the route. */
export class FyMergeGateGateway implements IMergeGateGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async mergeGate(pr: string) {
    return await this.client.request(
      `/v1/board/merge-gate?${new URLSearchParams({ pr }).toString()}`,
      BoardMergeGateResponseSchema,
    );
  }
}
