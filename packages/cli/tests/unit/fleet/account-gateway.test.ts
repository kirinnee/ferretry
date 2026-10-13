import { describe, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import should from 'should';
import type { z } from 'zod';
import { ProtocolAccountGateway, TOOL_INSTALL_TIMEOUT_MS } from '../../../src/lib/fleet/account-gateway.ts';
import { bundle, changeView, committed, credential, flow, machine, scan } from './account-fakes.ts';

interface Sent {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly timeoutMs: number | undefined;
}

/** A client that answers each path with a canned body, parsed through the schema the gateway gave. */
function client(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  return {
    sent,
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      sent.push({ path, init, timeoutMs });
      return schema.parse(answers[path]);
    },
  };
}

const body = (sent: Sent | undefined): unknown => JSON.parse(String(sent?.init?.body));
const headers = (sent: Sent | undefined): Record<string, string> =>
  (sent?.init?.headers ?? {}) as Record<string, string>;

const flowAnswer = flow({ state: 'complete' });

describe('ProtocolAccountGateway', () => {
  it('should read the catalogue routes', async () => {
    // Arrange
    const fake = client({
      '/v1/fleet/machine': machine(),
      '/v1/fleet/components': { format: 'version-2', kinds: [] },
      '/v1/fleet/profiles': { format: 'version-2', profiles: [] },
      '/v1/fleet/runtimes': { format: 'version-2', runtimes: [] },
      '/v1/fleet/credentials': { format: 2, machine: 'studio', credentials: [] },
    });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.machine();
    await gateway.components();
    await gateway.profiles();
    await gateway.runtimes();
    await gateway.credentials();

    // Assert
    should(fake.sent.map(sent => sent.path)).eql([
      '/v1/fleet/machine',
      '/v1/fleet/components',
      '/v1/fleet/profiles',
      '/v1/fleet/runtimes',
      '/v1/fleet/credentials',
    ]);
  });

  it('should trade the password for an unlock', async () => {
    const fake = client({
      '/v1/grants/unlock': {
        token: `fy_unlock_${'a'.repeat(22)}`,
        expiresAt: '2026-10-13T00:05:00.000Z',
        ttlSeconds: 300,
      },
    });
    should(await new ProtocolAccountGateway(fake).unlock('operator-password-1')).equal(`fy_unlock_${'a'.repeat(22)}`);
    should(body(fake.sent[0])).eql({ password: 'operator-password-1' });
    should(headers(fake.sent[0])).eql({ 'content-type': 'application/json' });
  });

  it('should send the unlock in a header and the password in the body, never the other way round', async () => {
    // Arrange
    const change = { kind: 'runtime.remove', name: 'old' } as const;
    const fake = client({
      '/v1/fleet/proposals': changeView(change),
      '/v1/fleet/proposals/fy_fprop_AAAAAAAAAAAAAAAAAAAAAA/apply': committed(),
      '/v1/fleet/credentials/claude%20you/check': credential(),
    });
    const gateway = new ProtocolAccountGateway(fake);
    const authority = { unlock: 'unlock-token', password: 'operator-password-1' };

    // Act
    await gateway.stage(change, { unlock: 'unlock-token' });
    await gateway.apply('fy_fprop_AAAAAAAAAAAAAAAAAAAAAA', authority);
    await gateway.check('claude you', {});

    // Assert
    should(body(fake.sent[0])).eql({ change });
    should(headers(fake.sent[0])[OPERATOR_UNLOCK_HEADER]).equal('unlock-token');
    should(body(fake.sent[1])).eql({ operatorPassword: 'operator-password-1' });
    should(headers(fake.sent[1])[OPERATOR_UNLOCK_HEADER]).equal('unlock-token');
    should(body(fake.sent[2])).eql({});
    should(headers(fake.sent[2])).not.have.property(OPERATOR_UNLOCK_HEADER);
  });

  it('should speak the setup routes, with longer patience for the slow ones', async () => {
    // Arrange
    const fake = client({
      '/v1/fleet/setup/scan': scan(),
      '/v1/fleet/machine/tools/install': { outcomes: [{ harness: 'codex', outcome: 'already-installed' }] },
      '/v1/fleet/export': bundle(),
    });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.scan({ unlock: 'u' });
    await gateway.installTools(['codex'], { password: 'operator-password-1' });
    await gateway.exportBundle({});

    // Assert
    should(fake.sent[0]?.init?.method).equal('GET');
    should(body(fake.sent[1])).eql({ harnesses: ['codex'], operatorPassword: 'operator-password-1' });
    should(fake.sent[1]?.timeoutMs).equal(TOOL_INSTALL_TIMEOUT_MS);
  });

  it('should start, read, answer and cancel a sign-in by credential', async () => {
    // Arrange
    const fake = client({
      '/v1/fleet/login': flowAnswer,
      '/v1/fleet/login/flow-1': flowAnswer,
    });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.startSignIn('claude-you', {});
    await gateway.signInStatus('flow-1', {});
    fake.sent.length = 0;
    const answers = client({ '/v1/fleet/login/flow-1': { outcome: 'refused', reason: 'Codex takes no code.' } });
    await new ProtocolAccountGateway(answers).submitSignInCode('flow-1', 'abc', {});
    await gateway.cancelSignIn('flow-1', { unlock: 'u' });

    // Assert
    should(body(answers.sent[0])).eql({ code: 'abc' });
    should(fake.sent[0]?.init?.method).equal('DELETE');
    should(headers(fake.sent[0])[OPERATOR_UNLOCK_HEADER]).equal('u');
  });
});

describe('ProtocolAccountGateway Codex method', () => {
  it('should send a Codex sign-in method only when one is chosen', async () => {
    // Arrange
    const fake = client({ '/v1/fleet/login': flowAnswer });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.startSignIn('codex-you', {}, 'link');
    await gateway.startSignIn('codex-you', {});

    // Assert
    should(body(fake.sent[0])).eql({ credentialId: 'codex-you', method: 'link' });
    should(body(fake.sent[1])).eql({ credentialId: 'codex-you' });
  });
});
