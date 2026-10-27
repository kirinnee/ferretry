import { describe, it } from 'bun:test';
import should from 'should';
import {
  firstRegistrationAttempt,
  nextRegistrationAttempt,
  providerText,
  type RegistrationAnswer,
  type RegistrationAttempt,
  registrationAnswer,
  registrationMetadata,
  registrationRefusal,
  unreachableSentence,
} from '../../../src/lib/mcp-oauth/index.ts';

type Rejected = Extract<RegistrationAnswer, { readonly kind: 'rejected' }>;

const rejected = (status: number, error?: string, description?: string): Rejected => ({
  kind: 'rejected',
  status,
  ...(error === undefined ? {} : { error }),
  ...(description === undefined ? {} : { description }),
});

const PWA = firstRegistrationAttempt('pwa');

describe('registrationMetadata', () => {
  it('should send what Claude Code sends, scope included when known', () => {
    // Act
    const metadata = registrationMetadata(PWA, 'https://p.example/cb', 'Ferretry', 'mcp:tools');

    // Assert
    should(metadata).deepEqual({
      client_name: 'Ferretry',
      redirect_uris: ['https://p.example/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools',
    });
  });

  it('should leave every optional field out of the minimal form, and `none` with them', () => {
    // Act
    const publicClient = registrationMetadata({ ...PWA, minimal: true }, 'https://p.example/cb', 'Ferretry', 'x');
    const secretClient = registrationMetadata(
      { ...PWA, minimal: true, auth: 'client_secret_basic' },
      'https://p.example/cb',
      'Ferretry',
      undefined,
    );

    // Assert
    should(publicClient).deepEqual({ client_name: 'Ferretry', redirect_uris: ['https://p.example/cb'] });
    should(secretClient).deepEqual({
      client_name: 'Ferretry',
      redirect_uris: ['https://p.example/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });
});

describe('registrationAnswer', () => {
  it('should read a public and a confidential registration', () => {
    should(registrationAnswer(201, JSON.stringify({ client_id: 'c1' }), 'none')).deepEqual({
      kind: 'registered',
      clientId: 'c1',
    });
    should(
      registrationAnswer(200, JSON.stringify({ client_id: 'c1', client_secret: 'secret-0123456789' }), 'none'),
    ).deepEqual({ kind: 'registered', clientId: 'c1', clientSecret: 'secret-0123456789' });
  });

  it('should send a secret the way the provider says, else the way it was asked for, else RFC 7591’s default', () => {
    const body = (extra: Record<string, unknown>) =>
      JSON.stringify({ client_id: 'c1', client_secret: 'secret-0123456789', ...extra });

    should(
      registrationAnswer(201, body({ token_endpoint_auth_method: 'client_secret_basic' }), 'client_secret_post'),
    ).containEql({ tokenAuth: 'client_secret_basic' });
    should(registrationAnswer(201, body({}), 'client_secret_basic')).containEql({ tokenAuth: 'client_secret_basic' });
    should(registrationAnswer(201, body({}), undefined)).containEql({ tokenAuth: 'client_secret_basic' });
    should(registrationAnswer(201, body({}), 'client_secret_post')).not.have.property('tokenAuth');
  });

  it('should keep the status, the error code and a cleaned description of a refusal (RFC 7591 §3.2.2)', () => {
    // Act
    const answer = registrationAnswer(
      400,
      JSON.stringify({ error: 'invalid_client_metadata', error_description: 'redirect_uris\nmust be https' }),
      'none',
    );

    // Assert
    should(answer).deepEqual(rejected(400, 'invalid_client_metadata', 'redirect_uris must be https'));
  });

  it('should keep only the status of a refusal with no usable reason', () => {
    should(registrationAnswer(503, '<html>down</html>', 'none')).deepEqual(rejected(503));
    should(registrationAnswer(400, JSON.stringify({ error: 'bad"quote' }), 'none')).deepEqual(rejected(400));
    should(registrationAnswer(400, JSON.stringify({ error: 7 }), 'none')).deepEqual(rejected(400));
  });

  it('should call a success with no client id unreadable', () => {
    should(registrationAnswer(201, '{}', 'none')).deepEqual({ kind: 'unreadable', status: 201 });
  });
});

describe('nextRegistrationAttempt', () => {
  it('should try the next client authentication when the provider talks about it', () => {
    // Act
    const post = nextRegistrationAttempt(
      PWA,
      rejected(400, 'invalid_client_metadata', 'token_endpoint_auth_method none'),
    );
    const basic = nextRegistrationAttempt(
      post as RegistrationAttempt,
      rejected(400, 'invalid_client_metadata', 'public clients are not allowed'),
    );

    // Assert
    should(post).deepEqual({ ...PWA, auth: 'client_secret_post' });
    should(basic).deepEqual({ ...PWA, auth: 'client_secret_basic' });
  });

  it('should leave the optional fields out when the provider objects to one', () => {
    should(nextRegistrationAttempt(PWA, rejected(400, 'invalid_client_metadata', 'unknown scope mcp:tools'))).deepEqual(
      {
        ...PWA,
        minimal: true,
      },
    );
  });

  it('should try a localhost address after any other 4xx to the PWA’s', () => {
    should(nextRegistrationAttempt(PWA, rejected(403, 'access_denied'))).deepEqual({ ...PWA, redirect: 'loopback' });
    should(nextRegistrationAttempt(PWA, rejected(400, 'invalid_redirect_uri'))).deepEqual({
      ...PWA,
      redirect: 'loopback',
    });
  });

  it('should try the minimal form once on a plain 400 to a localhost address, then stop', () => {
    const loopback = firstRegistrationAttempt('loopback');
    const minimal = nextRegistrationAttempt(loopback, rejected(400));

    should(minimal).deepEqual({ ...loopback, minimal: true });
    should(nextRegistrationAttempt(minimal as RegistrationAttempt, rejected(400))).be.undefined();
    should(nextRegistrationAttempt(loopback, rejected(401))).be.undefined();
  });

  it('should never retry a provider that failed (5xx)', () => {
    should(nextRegistrationAttempt(PWA, rejected(503, 'temporarily_unavailable'))).be.undefined();
  });
});

describe('providerText', () => {
  it('should mask anything shaped like a credential, and a query string', () => {
    // Act
    const text = providerText(
      'bad request client_secret=hunter2 token: "abc" see https://idp.example/docs?sig=abcdef0123456789 eyJhbGciOiJIUzI1NiJ9abcdef0123',
      400,
    );

    // Assert
    should(text).equal(
      'bad request client_secret=[redacted] token: [redacted] see https://idp.example/docs [redacted]',
    );
  });

  it('should keep ordinary long words, flatten control characters and bound the length', () => {
    should(providerText('token_endpoint_auth_method\u0000is\tinvalid', 300)).equal(
      'token_endpoint_auth_method is invalid',
    );
    should(providerText('x'.repeat(50), 10)).equal(`${'x'.repeat(9)}…`);
    should(providerText(' \n ', 10)).be.undefined();
  });
});

describe('registrationRefusal', () => {
  it('should say the provider refused new apps, with its reason, status, host and every way tried', () => {
    // Act
    const message = registrationRefusal(
      'auth.example.com',
      rejected(400, 'invalid_client_metadata', 'redirect_uris not allowed'),
      [PWA, { ...PWA, redirect: 'loopback' }],
    );

    // Assert
    should(message).startWith(
      'The sign-in provider refused new apps: invalid_client_metadata — redirect_uris not allowed. auth.example.com answered HTTP 400',
    );
    should(message).containEql('Tried 2 ways: the Ferretry page; a localhost address.');
    should(message).containEql('client id');
  });

  it('should say a refusal with no reason, a provider failure and an unreadable answer apart', () => {
    should(registrationRefusal('a.example', rejected(403), [PWA])).startWith(
      'The sign-in provider refused new apps: no reason given. a.example answered HTTP 403',
    );
    should(registrationRefusal('a.example', rejected(502), [PWA])).startWith(
      'The sign-in provider failed while registering Ferretry: no reason given. a.example answered HTTP 502',
    );
    should(registrationRefusal('a.example', { kind: 'unreadable', status: 200 }, [PWA])).containEql(
      'without a client id',
    );
  });

  it('should say an unreachable provider is a network problem, and where the proxy and certificate help is', () => {
    // Act
    const dns = registrationRefusal('a.example', { kind: 'unreachable', reason: 'ENOTFOUND' }, [PWA]);
    const tls = unreachableSentence('a.example', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'register Ferretry');

    // Assert
    should(dns).startWith('Ferretry’s daemon couldn’t reach a.example to register Ferretry — no answer came back');
    should(dns).containEql('(network error: ENOTFOUND)');
    should(dns).containEql('proxy or a company certificate');
    should(tls).containEql('its certificate is not one the daemon trusts');
  });
});
