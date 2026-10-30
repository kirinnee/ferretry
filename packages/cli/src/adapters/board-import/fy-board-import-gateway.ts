import { BoardImportSummarySchema, type IFyApiClient } from '@ferretry/protocol';
import type { IBoardImportGateway } from '../../lib/board-import/ports';

/** The board import route of the daemon API; the only place the command knows about URLs. */
export class FyBoardImportGateway implements IBoardImportGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async run(dryRun: boolean) {
    return this.client.request('/v1/board/import', BoardImportSummarySchema, {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
      headers: { 'content-type': 'application/json' },
    });
  }
}
