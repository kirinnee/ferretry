import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import type { z } from 'zod';
import {
  OLD_DAEMON_MESSAGE,
  OWNER_ONLY_MESSAGE,
  ProtocolAccountGateway,
} from '../../../src/lib/secrets/account-gateway';
import type { AccountApiClient } from '../../../src/lib/secrets/account-ports';
import { AT, GITHUB, GITHUB_SIGN_IN, LIST, refusal, SI_GITHUB, TF_SMS } from './account-rig';

interface Sent {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: unknown;
}

/** A client that answers each request with the next reply, and records what was sent. */
function client(replies: unknown[]): { client: AccountApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
        sent.push({
          path,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          headers: init?.headers,
        });
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return schema.parse(reply);
      },
    },
  };
}

describe('ProtocolAccountGateway', () => {
  it('should read the list, a hint and the look-alike groups with GET and no body', async () => {
    // Arrange
    const { client: api, sent } = client([
      LIST,
      { v: 1, site: 'github.com', hints: [], passkeys: 'off' },
      { v: 1, groups: [] },
    ]);
    const gateway = new ProtocolAccountGateway(api);

    // Act
    await gateway.list();
    await gateway.hint('github.com');
    await gateway.lookAlike();

    // Assert
    should(sent.map(call => `${call.method} ${call.path}`)).deepEqual([
      'GET /v1/accounts',
      'GET /v1/accounts/hint?site=github.com',
      'GET /v1/accounts/look-alike',
    ]);
    should(sent.every(call => call.body === undefined)).be.true();
  });

  it('should send each write to its own route as JSON', async () => {
    // Arrange
    const { client: api, sent } = client([
      GITHUB,
      GITHUB,
      { id: 'GITHUB', removed: true },
      GITHUB,
      GITHUB,
      GITHUB_SIGN_IN,
      GITHUB_SIGN_IN,
      { id: SI_GITHUB, removed: true },
      GITHUB_SIGN_IN,
      { defaults: { sites: { 'github.com': 'GITHUB' } } },
      { id: TF_SMS, kind: 'sms', label: 'Phone', addedAt: AT, addedBy: 'owner', automatic: false },
      { account: 'GITHUB', factor: TF_SMS, removed: true },
    ]);
    const gateway = new ProtocolAccountGateway(api);

    // Act
    await gateway.putAccount('GITHUB', { label: 'GH' });
    await gateway.renameAccount('GITHUB', 'GH_MAIN');
    await gateway.removeAccount('GITHUB');
    await gateway.merge('GITHUB', 'OTHER');
    await gateway.apart('GITHUB', 'OTHER');
    await gateway.addSignIn('GITHUB', { place: { kind: 'site', domains: ['github.com'], match: [] } });
    await gateway.putSignIn(SI_GITHUB, { autoApplyRecipe: true });
    await gateway.removeSignIn(SI_GITHUB);
    await gateway.decideRecipe(SI_GITHUB, 'rp_0123456789abcdef', 'approve');
    await gateway.putDefault({ scope: 'sites', key: 'github.com', account: 'GITHUB' });
    await gateway.addFactor('GITHUB', { label: 'Phone', kind: 'sms', endsWith: '42' });
    await gateway.removeFactor('GITHUB', TF_SMS);

    // Assert
    should(sent.map(call => `${call.method} ${call.path}`)).deepEqual([
      'PUT /v1/accounts/GITHUB',
      'POST /v1/accounts/GITHUB/rename',
      'DELETE /v1/accounts/GITHUB',
      'POST /v1/accounts/GITHUB/merge',
      'POST /v1/accounts/GITHUB/apart',
      'POST /v1/accounts/GITHUB/sign-ins',
      `PUT /v1/accounts/sign-ins/${SI_GITHUB}`,
      `DELETE /v1/accounts/sign-ins/${SI_GITHUB}`,
      `POST /v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/rp_0123456789abcdef`,
      'PUT /v1/accounts/defaults',
      'POST /v1/accounts/GITHUB/factors',
      `DELETE /v1/accounts/GITHUB/factors/${TF_SMS}`,
    ]);
    should(sent[3]?.body).deepEqual({ from: 'OTHER' });
    should(sent[8]?.body).deepEqual({ decision: 'approve' });
    should(sent[9]?.body).deepEqual({ scope: 'sites', key: 'github.com', account: 'GITHUB' });
  });

  it('should refuse, before sending, a body the protocol would not accept', async () => {
    // Arrange
    const { client: api, sent } = client([]);
    const gateway = new ProtocolAccountGateway(api);

    // Act
    const sneaky = () => gateway.putAccount('GITHUB', { label: 'GH', seed: 'JBSWY3DPEHPK3PXP' } as never);
    const refused = await sneaky().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(Error);
    should(sent).have.length(0);
  });

  it('should name an older daemon when the account routes are missing', async () => {
    // Arrange
    const { client: api } = client([new FyHttpError('not found', 404, undefined)]);

    // Act
    const message = await refusal(() => new ProtocolAccountGateway(api).list());

    // Assert
    should(message).equal(OLD_DAEMON_MESSAGE);
    should(message).containEql('fy daemon update');
  });

  it('should keep "no such account" as the daemon’s own 404, since it carries a code', async () => {
    // Arrange
    const missing = new FyHttpError('no such account', 404, 'not_found');
    const { client: api } = client([missing]);

    // Act
    const error = await new ProtocolAccountGateway(api).removeAccount('NOPE').catch((thrown: unknown) => thrown);

    // Assert
    should(error).equal(missing);
  });

  it('should say a ferret’s write is the owner’s, and try nothing else', async () => {
    // Arrange
    const { client: api, sent } = client([new FyHttpError('this is a person route', 403, 'forbidden')]);

    // Act
    const message = await refusal(() => new ProtocolAccountGateway(api).putAccount('GITHUB', { label: 'x' }));

    // Assert
    should(message).containEql(OWNER_ONLY_MESSAGE);
    should(message).containEql('no other credential was tried');
    should(sent).have.length(1);
  });

  it('should pass any other refusal through untouched', async () => {
    // Arrange
    const conflict = new FyHttpError('already there', 409, 'conflict');
    const broken = new TypeError('socket');
    const first = client([conflict]);
    const second = client([broken]);

    // Act
    const a = await new ProtocolAccountGateway(first.client).merge('A', 'B').catch((thrown: unknown) => thrown);
    const b = await new ProtocolAccountGateway(second.client).list().catch((thrown: unknown) => thrown);

    // Assert
    should(a).equal(conflict);
    should(b).equal(broken);
  });
});
