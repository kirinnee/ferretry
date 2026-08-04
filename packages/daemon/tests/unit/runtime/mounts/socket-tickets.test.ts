import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, ApiRouter, SocketTicketRegistry } from '../../../../src/lib/api/index.ts';
import { socketTicketRoutes } from '../../../../src/lib/runtime/index.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

/**
 * The counter where a browser buys the credential it can actually carry onto an upgrade.
 *
 * The two properties that matter are not about the happy path. A ticket must never widen what its
 * buyer may do — a phone's ticket is a phone's — and it must be worthless anywhere but an upgrade,
 * because a URL-borne credential is a credential in an access log.
 */

const deviceToken = { authorization: 'Bearer device-secret' } as const;
const credentials = {
  ...CREDENTIALS,
  devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
};

function fixture() {
  const tickets = new SocketTicketRegistry({ now: () => 1_000 }, { ticket: () => `fy_ticket_${'t'.repeat(43)}` });
  return { tickets, http: new ApiDispatcher(new ApiRouter(socketTicketRoutes(tickets)), credentials) };
}

async function sell(headers: Readonly<Record<string, string>>) {
  const { tickets, http } = fixture();
  const response = await http.dispatch(request({ method: 'POST', path: '/v1/events/ticket', headers }));
  return { tickets, response };
}

describe('the mounted socket ticket counter', () => {
  it('should sell the human a ticket that redeems as the human', async () => {
    // Arrange / Act
    const { tickets, response } = await sell(human);
    const body = JSON.parse(response.body) as { readonly ticket: string; readonly ttlSeconds: number };

    // Assert
    should(response.status).equal(201);
    should(body.ttlSeconds).equal(30);
    should(tickets.redeem(body.ticket, '/v1/events')).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });

  it('should sell a paired device a ticket that redeems as THAT device', async () => {
    // Arrange / Act
    const { tickets, response } = await sell(deviceToken);
    const body = JSON.parse(response.body) as { readonly ticket: string };

    // Assert — the whole point: a ticket carries its buyer's own class and identity, so a transport
    // workaround can never be a way to reach the host's surface, and the journal still names the phone.
    should(response.status).equal(201);
    should(tickets.redeem(body.ticket, '/v1/events')).deepEqual({
      kind: 'authenticated',
      tokenClass: 'device',
      deviceId: 'device-1',
    });
  });

  it('should never let a ticket be spent on an ordinary route', async () => {
    // Arrange — the request/response boundary is given no redeemer at all, which is what makes this
    // structural rather than a rule someone has to remember.
    const { tickets, response } = await sell(human);
    const { ticket } = JSON.parse(response.body) as { readonly ticket: string };
    const { http } = fixture();

    // Act
    const replayed = await http.dispatch(
      request({ method: 'POST', path: '/v1/events/ticket', query: [['ticket', ticket]] }),
    );

    // Assert — refused, and the ticket is still unspent because nothing here could even look at it.
    should(replayed.status).equal(401);
    should(tickets.redeem(ticket, '/v1/events')).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });

  it('should refuse an anonymous caller rather than mint a ticket with no buyer', async () => {
    // Arrange / Act
    const { response } = await sell({});

    // Assert
    should(response.status).equal(401);
  });

  it('should refuse to answer a caller whose credential it cannot see', async () => {
    // Arrange — unreachable through the dispatcher, which always resolves one for a non-public route.
    // Asserted directly because the alternative to knowing WHO asked is minting authority for nobody.
    const { tickets } = fixture();
    const [route] = socketTicketRoutes(tickets);

    // Act
    const response = await route?.handle({
      request: request({ method: 'POST', path: '/v1/events/ticket' }),
      params: new Map(),
    });

    // Assert
    should(response?.status).equal(401);
  });

  it('should not store the ticket in any shared cache', async () => {
    // Arrange / Act
    const { response } = await sell(human);

    // Assert — it is a credential; a proxy or a browser holding a copy defeats the single use.
    should(response.headers?.get('cache-control')).equal('no-store');
  });
});
