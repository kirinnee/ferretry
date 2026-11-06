import { describe, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import should from 'should';
import { FyMergeGateGateway } from '../../../src/adapters/board/fy-merge-gate-gateway';

const PR = 'https://github.com/kirinnee/ferretry/pull/42';

describe('the merge gate gateway', () => {
  it("should ask the daemon's merge gate with the PR URL escaped in the query, and parse the answer", async () => {
    // Arrange
    const paths: string[] = [];
    const request = ((path: string, schema: { parse(value: unknown): unknown }) => {
      paths.push(path);
      return Promise.resolve(
        schema.parse({
          pr: PR,
          unit: [{ id: 'F20' }],
          waits: [{ task: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }],
          unreadable: [],
        }),
      );
    }) as unknown as IFyApiClient['request'];

    // Act
    const answer = await new FyMergeGateGateway({ request }).mergeGate(PR);

    // Assert
    should(paths).eql([`/v1/board/merge-gate?pr=${encodeURIComponent(PR)}`]);
    should(answer.waits).eql([{ task: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }]);
  });

  it('should refuse an answer that is not a merge gate', async () => {
    // Arrange
    const request = ((_path: string, schema: { parse(value: unknown): unknown }) =>
      Promise.resolve().then(() => schema.parse({ pr: PR, unit: [] }))) as unknown as IFyApiClient['request'];

    // Act
    const refused = await new FyMergeGateGateway({ request }).mergeGate(PR).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(Error);
  });
});
