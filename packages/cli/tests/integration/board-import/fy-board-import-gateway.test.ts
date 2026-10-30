import { describe, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import should from 'should';
import { FyBoardImportGateway } from '../../../src/adapters/board-import/fy-board-import-gateway';

const answer = {
  dryRun: true,
  skipped: false,
  sessions: 0,
  imported: 0,
  alreadyImported: 0,
  proposedProjects: [],
  linkedAsks: 0,
  untriagedCards: 0,
  problems: [],
  complete: false,
};

describe('the board import gateway', () => {
  it.each([true, false])('should post dryRun=%s as JSON to the import route and parse the summary', async dryRun => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(answer));
    }) as unknown as IFyApiClient['request'];

    const summary = await new FyBoardImportGateway({ request }).run(dryRun);

    should(summary.dryRun).equal(true);
    should(calls[0]?.path).equal('/v1/board/import');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ dryRun });
  });
});
