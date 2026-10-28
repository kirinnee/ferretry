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

  it('should call a success with no client id unreadable, and say which field', () => {
    should(registrationAnswer(201, '{}', 'none')).deepEqual({
      kind: 'unreadable',
      status: 201,
      problem: 'its client_id was missing',
    });
  });

  describe('a success shaped the way real providers answer', () => {
    const answer = (body: unknown) => registrationAnswer(201, JSON.stringify(body), 'none');

    it('should take a client id that is a number, as text', () => {
      should(answer({ client_id: 12345 })).deepEqual({ kind: 'registered', clientId: '12345' });
    });

    it('should take an empty or null secret as no secret', () => {
      should(answer({ client_id: 'c1', client_secret: '' })).deepEqual({ kind: 'registered', clientId: 'c1' });
      should(answer({ client_id: 'c1', client_secret: null })).deepEqual({ kind: 'registered', clientId: 'c1' });
    });

    it('should take a null authentication method as unsaid, and ignore its type when it is not text', () => {
      should(answer({ client_id: 'c1', client_secret: 's-0123456789', token_endpoint_auth_method: null })).deepEqual({
        kind: 'registered',
        clientId: 'c1',
        clientSecret: 's-0123456789',
      });
      should(answer({ client_id: 'c1', token_endpoint_auth_method: 7 })).deepEqual({
        kind: 'registered',
        clientId: 'c1',
      });
    });

    it('should ignore unknown fields, a zero secret expiry and nested values', () => {
      should(
        answer({
          client_id: 'c1',
          client_secret_expires_at: 0,
          client_id_issued_at: 1700000000,
          registration_client_uri: 'https://p.example/register/c1',
          extra: { nested: [1, 2, { deep: null }] },
        }),
      ).deepEqual({ kind: 'registered', clientId: 'c1' });
    });

    it('should read a body with a byte-order mark', () => {
      should(registrationAnswer(201, `\uFEFF${JSON.stringify({ client_id: 'c1' })}`, 'none')).deepEqual({
        kind: 'registered',
        clientId: 'c1',
      });
    });

    it('should read the MCP SDK’s own example registration response', () => {
      // Arrange — the shape of OAuthClientInformationFull in the SDK's documentation
      const sdkExample = {
        client_id: 'client-1234',
        client_secret: 'secret-abcdefghij',
        client_id_issued_at: 1700000000,
        client_secret_expires_at: 0,
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'My MCP Client',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'mcp:tools',
      };

      // Act / Assert
      should(registrationAnswer(201, JSON.stringify(sdkExample), 'none')).deepEqual({
        kind: 'registered',
        clientId: 'client-1234',
        clientSecret: 'secret-abcdefghij',
      });
    });
  });

  describe('a success that still cannot be used', () => {
    const problem = (status: number, text: string) => {
      const out = registrationAnswer(status, text, 'none');
      return out.kind === 'unreadable' ? out.problem : out.kind;
    };

    it('should name the wrong field and its JSON type, never its value', () => {
      should(problem(201, JSON.stringify({ client_id: { secret: 'hush' } }))).equal('its client_id was a JSON object');
      should(problem(201, JSON.stringify({ client_id: null }))).equal('its client_id was null');
      should(problem(201, JSON.stringify({ client_id: true }))).equal('its client_id was a boolean');
      should(problem(201, JSON.stringify({ client_id: [1] }))).equal('its client_id was a JSON array');
      should(problem(201, JSON.stringify({ client_id: '' }))).equal('its client_id was empty');
      should(problem(201, JSON.stringify({ client_id: 'x'.repeat(513) }))).equal('its client_id was too long');
      should(problem(201, JSON.stringify({ client_id: 'c1', client_secret: { a: 1 } }))).equal(
        'its client_secret was a JSON object',
      );
    });

    it('should say when the whole answer is not an object or not JSON', () => {
      should(problem(201, '[1]')).equal('its answer was a JSON array, not a JSON object');
      should(problem(201, '"c1"')).equal('its answer was a string, not a JSON object');
      should(problem(200, '<html>ok</html>')).equal('its answer was not JSON');
    });
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
    should(
      registrationRefusal(
        'a.example',
        { kind: 'unreadable', status: 201, problem: 'its client_id was a JSON object' },
        [PWA],
      ),
    ).startWith(
      'The sign-in provider at a.example answered the registration (HTTP 201) but its client_id was a JSON object, so the sign-in could not start.',
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
