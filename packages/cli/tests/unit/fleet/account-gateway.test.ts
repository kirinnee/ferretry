import { describe, it } from 'bun:test';
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

  it('should carry no credential of any kind, in a header or in a body', async () => {
    // Arrange
    const change = { kind: 'runtime.remove', name: 'old' } as const;
    const fake = client({
      '/v1/fleet/proposals': changeView(change),
      '/v1/fleet/proposals/fy_fprop_AAAAAAAAAAAAAAAAAAAAAA/apply': committed(),
      '/v1/fleet/credentials/claude%20you/check': credential(),
    });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.stage(change);
    await gateway.apply('fy_fprop_AAAAAAAAAAAAAAAAAAAAAA');
    await gateway.check('claude you');

    // Assert
    should(body(fake.sent[0])).eql({ change });
    should(body(fake.sent[1])).eql({});
    should(body(fake.sent[2])).eql({});
    for (const sent of fake.sent) should(headers(sent)).eql({ 'content-type': 'application/json' });
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
    await gateway.scan();
    await gateway.installTools(['codex']);
    await gateway.exportBundle();

    // Assert
    should(fake.sent[0]?.init?.method).equal('GET');
    should(body(fake.sent[1])).eql({ harnesses: ['codex'] });
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
    await gateway.startSignIn('claude-you');
    await gateway.signInStatus('flow-1');
    fake.sent.length = 0;
    const answers = client({ '/v1/fleet/login/flow-1': { outcome: 'refused', reason: 'Codex takes no code.' } });
    await new ProtocolAccountGateway(answers).submitSignInCode('flow-1', 'abc');
    await gateway.cancelSignIn('flow-1');

    // Assert
    should(body(answers.sent[0])).eql({ code: 'abc' });
    should(fake.sent[0]?.init?.method).equal('DELETE');
  });
});

describe('ProtocolAccountGateway Codex method', () => {
  it('should send a Codex sign-in method only when one is chosen', async () => {
    // Arrange
    const fake = client({ '/v1/fleet/login': flowAnswer });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.startSignIn('codex-you', 'link');
    await gateway.startSignIn('codex-you');
    await gateway.startSignIn('codex-you', undefined, true);
    await gateway.startSignIn('codex-you', undefined, false);

    // Assert
    should(body(fake.sent[0])).eql({ credentialId: 'codex-you', method: 'link' });
    should(body(fake.sent[1])).eql({ credentialId: 'codex-you' });
    should(body(fake.sent[2])).eql({ credentialId: 'codex-you', restart: true });
    should(body(fake.sent[3])).eql({ credentialId: 'codex-you' });
  });
});

describe('ProtocolAccountGateway environment logins', () => {
  it('should read the presets and test a login, sending consent only when it is given', async () => {
    // Arrange
    const result = {
      credentialId: 'glm',
      ok: true,
      code: 'ok',
      message: 'The provider accepted this login.',
      spent: 'nothing',
      at: '2026-10-16T09:00:00.000Z',
    };
    const fake = client({ '/v1/fleet/presets': { presets: [] }, '/v1/fleet/credentials/glm/test': result });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.presets();
    await gateway.test('glm', false);
    await gateway.test('glm', true);

    // Assert
    should(fake.sent.map(sent => [sent.path, sent.init?.method])).deepEqual([
      ['/v1/fleet/presets', 'GET'],
      ['/v1/fleet/credentials/glm/test', 'POST'],
      ['/v1/fleet/credentials/glm/test', 'POST'],
    ]);
    should(body(fake.sent[1])).deepEqual({});
    should(body(fake.sent[2])).deepEqual({ allowInference: true });
  });

  it('should read the secret store’s names for a one-click add, treating "damaged" as none', async () => {
    // Arrange
    const AT = '2026-10-16T09:00:00.000Z';
    const ready = client({
      '/v1/secrets': {
        v: 1,
        health: 'ready',
        secrets: [{ name: 'ZAI_API_KEY', createdAt: AT, updatedAt: AT }],
        references: [],
      },
    });
    const damaged = client({
      '/v1/secrets': { v: 1, health: 'damaged', diagnosis: 'no key', secrets: [], references: [] },
    });

    // Act
    const names = await new ProtocolAccountGateway(ready).secretNames();
    const none = await new ProtocolAccountGateway(damaged).secretNames();

    // Assert
    should([...names]).eql(['ZAI_API_KEY']);
    should([...none]).eql([]);
  });

  it('should store a one-click secret through the very same client', async () => {
    // Arrange
    const AT = '2026-10-16T09:00:00.000Z';
    const fake = client({ '/v1/secrets': { name: 'ZAI_API_KEY', createdAt: AT, updatedAt: AT } });
    const gateway = new ProtocolAccountGateway(fake);

    // Act
    await gateway.putSecret('ZAI_API_KEY', 'sk-value');

    // Assert
    should(body(fake.sent[0])).eql({ name: 'ZAI_API_KEY', value: 'sk-value' });
    should(fake.sent[0]?.path).equal('/v1/secrets');
  });
});
