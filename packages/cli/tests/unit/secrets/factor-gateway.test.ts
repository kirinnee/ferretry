import { describe, it } from 'bun:test';
import { padInputValue } from '@ferretry/protocol';
import should from 'should';
import { DaemonFeaturesUnreadable } from '../../../src/lib/daemon/features';
import { health } from '../daemon/fixtures';
import { ProtocolTwoFactorSeedGateway } from '../../../src/lib/secrets/factor-gateway';

interface Seen {
  readonly path: string;
  readonly init?: { readonly method?: string; readonly body?: string };
}

const STAGE = `st_${'a'.repeat(24)}`;

/** The seed routes `fy account factor add --totp` speaks: stage, put on the agenda, watch. Never a commit. */
function gatewayOver(reply: unknown) {
  const seen: Seen[] = [];
  const client = {
    request: (path: string, schema: { parse(value: unknown): unknown }, init?: Seen['init']) => {
      seen.push({ path, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(schema.parse(reply));
    },
  };
  return { seen, gateway: new ProtocolTwoFactorSeedGateway(client as never) };
}

describe('ProtocolTwoFactorSeedGateway', () => {
  it('should read the features from the health route, and fail as unreadable when it cannot ask', async () => {
    const reported = gatewayOver(health({ features: ['accounts.2fa-keys.1'] }));
    const broken = new ProtocolTwoFactorSeedGateway({ request: () => Promise.reject(new Error('down')) } as never);

    should(await reported.gateway.features()).deepEqual(['accounts.2fa-keys.1']);
    should(reported.seen.map(call => call.path)).deepEqual(['/v1/health']);
    await should(broken.features()).be.rejectedWith(DaemonFeaturesUnreadable);
  });

  it('should stage, put on the agenda and watch a seed, each on its route, parsed both ways', async () => {
    // Arrange
    const stage = gatewayOver({
      stage: STAGE,
      account: 'GITHUB',
      label: 'Authenticator app',
      expiresAt: '2026-01-01T00:02:00.000Z',
      parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 } },
    });
    const confirm = gatewayOver({ stage: STAGE, session: 's1', agendaItemId: 'A7' });
    const view = gatewayOver({
      stage: STAGE,
      account: 'GITHUB',
      label: 'Authenticator app',
      state: 'waiting',
      expiresAt: '2026-01-01T00:02:00.000Z',
    });

    // Act
    await stage.gateway.stage('GITHUB', { padded: padInputValue('JBSWY3DPEHPK3PXP'), totpAcknowledged: true });
    await confirm.gateway.confirmInApp('GITHUB', STAGE, { session: 's1' });
    await view.gateway.view('GITHUB', STAGE);
    const refused = await stage.gateway
      .stage('GITHUB', { padded: 'x', totpAcknowledged: false } as never)
      .catch((error: unknown) => error);

    // Assert
    should(stage.seen[0]).match({ path: '/v1/accounts/GITHUB/factors/seed', init: { method: 'POST' } });
    should(confirm.seen[0]).match({
      path: `/v1/accounts/GITHUB/factors/seed/${STAGE}/confirm-in-app`,
      init: { method: 'POST', body: '{"session":"s1"}' },
    });
    should(view.seen[0]).deepEqual({ path: `/v1/accounts/GITHUB/factors/seed/${STAGE}` });
    should(refused).be.an.Error();
    should(stage.seen).have.length(1);
  });
});
