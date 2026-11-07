import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { wardenRoutes } from '../../../../src/lib/runtime/mounts/warden.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, FakeWarden, GRANTED } from './support.ts';

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

class ReportingWarden extends FakeWarden {
  override async report(reportPath: string): Promise<string | undefined> {
    return reportPath === '/state/warden/reports/latest.md' ? '# Sweep\n\nNothing to escalate.\n' : undefined;
  }
}

describe('serving a warden report', () => {
  it('should hand back the report text verbatim to a live warden', async () => {
    // Arrange
    const dispatch = new ApiDispatcher(new ApiRouter(wardenRoutes(new ReportingWarden())), CREDENTIALS, GRANTED);

    // Act
    const response = await dispatch.dispatch(
      request({
        method: 'GET',
        path: '/v1/warden/report',
        query: [['path', '/state/warden/reports/latest.md']],
        headers: warden,
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('# Sweep\n\nNothing to escalate.\n');
  });
});
