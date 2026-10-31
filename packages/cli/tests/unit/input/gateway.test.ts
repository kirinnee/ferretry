import { describe, it } from 'bun:test';
import { type InputDeliverBody, padInputValue } from '@ferretry/protocol';
import should from 'should';
import {
  inputCancelPath,
  inputDeliverPath,
  inputRequestsPath,
  ProtocolInputGateway,
} from '../../../src/lib/input/gateway';
import { DELIVERY, DIGEST, REQUEST_ID, request, SESSION, VALUE } from './fixtures';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

function client(answer: unknown) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: <T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> => {
        calls.push({ path, init });
        return Promise.resolve(schema.parse(answer));
      },
    },
  };
}

describe('ProtocolInputGateway', () => {
  it('should dial the routes the daemon serves, with the session and request encoded', () => {
    should(inputRequestsPath('a b')).equal('/v1/sessions/a%20b/input-requests');
    should(inputDeliverPath(SESSION, REQUEST_ID)).equal(`/v1/sessions/${SESSION}/input-requests/${REQUEST_ID}/deliver`);
    should(inputCancelPath(SESSION, REQUEST_ID)).equal(`/v1/sessions/${SESSION}/input-requests/${REQUEST_ID}/cancel`);
  });

  it('should list as the person at this machine, never naming a ferret session', async () => {
    // Arrange
    const { client: api, calls } = client({ requests: [request()] });

    // Act
    const list = await new ProtocolInputGateway(api).list(SESSION);

    // Assert
    should(list.requests).have.length(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    should(Object.keys(headers).map(name => name.toLowerCase())).not.containEql('x-ferretry-session-id');
  });

  it('should post the padded body and read back an outcome with no value in it', async () => {
    // Arrange
    const { client: api, calls } = client({
      id: REQUEST_ID,
      deliveryId: DELIVERY,
      state: 'delivered',
      submitted: true,
    });
    const body: InputDeliverBody = {
      deliveryId: DELIVERY,
      observedDigest: DIGEST,
      padded: padInputValue(VALUE),
      submit: true,
    };

    // Act
    const result = await new ProtocolInputGateway(api).deliver(SESSION, REQUEST_ID, body);

    // Assert
    should(result.state).equal('delivered');
    should(calls[0]?.init?.method).equal('POST');
    should(String(calls[0]?.init?.body)).containEql(DELIVERY);
    should(JSON.stringify(result)).not.containEql(VALUE);
  });

  it('should refuse to send a body that is not exactly one of padded or secretName', async () => {
    // Arrange
    const { client: api, calls } = client({});
    const bad = { deliveryId: DELIVERY, observedDigest: DIGEST, submit: true } as InputDeliverBody;

    // Act
    const failure = await new ProtocolInputGateway(api)
      .deliver(SESSION, REQUEST_ID, bad)
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.an.Error();
    should(calls).have.length(0);
  });

  it('should post an empty cancel and read the request back', async () => {
    // Arrange
    const { client: api, calls } = client(request({ state: 'cancelled' }));

    // Act
    const cancelled = await new ProtocolInputGateway(api).cancel(SESSION, REQUEST_ID);

    // Assert
    should(cancelled.state).equal('cancelled');
    should(calls[0]?.init?.body).equal('{}');
  });
});
