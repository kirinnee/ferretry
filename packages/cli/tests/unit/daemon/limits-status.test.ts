import { describe, it } from 'bun:test';
import should from 'should';
import { cgroupConfigView } from '../../../../protocol/tests/fixtures.ts';
import { ProtocolLimitsStatusReader, renderLimitsStatus } from '../../../src/lib/daemon/limits-status.ts';

const client = (answer: () => Promise<unknown>) => ({
  request: (async (path: string, schema: { parse(value: unknown): unknown }) => {
    should(path).equal('/v1/cgroups/config');
    return schema.parse(await answer());
  }) as never,
});

describe('ProtocolLimitsStatusReader', () => {
  it('should read the limits view the daemon built', async () => {
    // Act
    const read = await new ProtocolLimitsStatusReader(client(async () => cgroupConfigView)).read();

    // Assert
    should(read?.lines).deepEqual(cgroupConfigView.lines);
  });

  it('should answer nothing when the daemon is older (a body it cannot read) or the read fails', async () => {
    // Act + Assert
    should(await new ProtocolLimitsStatusReader(client(async () => ({ config: {}, supported: true }))).read()).equal(
      undefined,
    );
    should(
      await new ProtocolLimitsStatusReader(
        client(async () => {
          throw new Error('no token');
        }),
      ).read(),
    ).equal(undefined);
  });
});

describe('renderLimitsStatus', () => {
  it('should print the daemon’s own sentences under a heading, warnings last', () => {
    // Act
    const actual = renderLimitsStatus({ ...cgroupConfigView, warnings: ['this daemon is itself inside the slice'] });

    // Assert
    should(actual).deepEqual([
      '  Limits:',
      `    ${cgroupConfigView.lines[0]}`,
      '    warning: this daemon is itself inside the slice',
    ]);
  });
});
