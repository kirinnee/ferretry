import { describe, it } from 'bun:test';
import { padInputValue } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { inputRequestRoutes } from '../../../../src/lib/runtime/mounts/input-requests.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from '../../input-requests/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human } from './support.ts';

/**
 * The owner's input-request routes, driven through the real router and authorization boundary with the
 * real service behind them. Only the terminal, the board and the journal are fakes.
 */

const VALUE = 'hunter2-UNIQUE';

async function served(crash = false) {
  let crashing = false;
  const { service, writes } = inputRequestService({ crash: () => crash && crashing });
  await service.raise(SESSION, RAISE);
  const [open] = await service.list({ kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' });
  if (open === undefined) throw new Error('no request');
  crashing = true;
  const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);
  return { dispatch, writes, requestId: open.id, digest: open.observedDigest ?? '' };
}

const json = (body: unknown) => JSON.stringify(body);
const path = (requestId: string, verb: 'deliver' | 'cancel') =>
  `/v1/sessions/${SESSION}/input-requests/${requestId}/${verb}`;

const deliverBody = (digest: string, deliveryId = crypto.randomUUID()) => ({
  deliveryId,
  observedDigest: digest,
  padded: padInputValue(VALUE),
  submit: true,
});

const post = (target: string, body: unknown, headers: Readonly<Record<string, string>> = human, reads = bodyReads()) =>
  request({
    method: 'POST',
    path: target,
    headers: { ...headers, 'content-type': 'application/json' },
    body: json(body),
    reads,
  });

describe('the input request routes', () => {
  it('should list the open requests for the host, across sessions and for one session', async () => {
    const { dispatch, requestId } = await served();

    const all = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));
    const one = await dispatch.dispatch(
      request({ method: 'GET', path: `/v1/sessions/${SESSION}/input-requests`, headers: human }),
    );

    should(all.status).equal(200);
    should((jsonBody(all).requests as { id: string }[]).map(entry => entry.id)).eql([requestId]);
    should(one.status).equal(200);
    should((jsonBody(one).requests as unknown[]).length).equal(1);
  });

  it('should refuse an agent before it reads the body, on every route', async () => {
    const { dispatch, writes, requestId, digest } = await served();
    const reads = bodyReads();

    const deliver = await dispatch.dispatch(
      post(path(requestId, 'deliver'), deliverBody(digest), agentIn(SESSION), reads),
    );
    const cancel = await dispatch.dispatch(post(path(requestId, 'cancel'), {}, agentIn(SESSION), reads));
    const list = await dispatch.dispatch(
      request({ method: 'GET', path: '/v1/input-requests', headers: agentIn(SESSION) }),
    );

    should([deliver.status, cancel.status, list.status]).eql([403, 403, 403]);
    should(reads.consumed).be.false();
    should(writes).eql([]);
  });

  it('should deliver for the host and type the value once', async () => {
    const { dispatch, writes, requestId, digest } = await served();

    const response = await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody(digest)));

    should(response.status).equal(200);
    should(jsonBody(response).state).equal('delivered');
    should(writes.length).equal(1);
    should(response.body).not.containEql(VALUE);
  });

  it('should deliver for a paired device', async () => {
    const { dispatch, writes, requestId, digest } = await served();

    const response = await dispatch.dispatch(
      request({
        method: 'POST',
        path: path(requestId, 'deliver'),
        headers: { 'content-type': 'application/json' },
        body: json(deliverBody(digest)),
        device: { deviceId: 'device-1', appSession: 'app-one' },
      }),
    );

    should(response.status).equal(200);
    should(writes.length).equal(1);
  });

  it('should map a refusal to its status and wire code', async () => {
    const { dispatch, writes, requestId, digest } = await served();

    const stale = await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody('f'.repeat(64))));
    const missing = await dispatch.dispatch(post(path('f'.repeat(32), 'deliver'), deliverBody(digest)));

    should(stale.status).equal(409);
    should(jsonBody(stale).code).equal('target_changed');
    should(missing.status).equal(404);
    should(writes).eql([]);
  });

  it('should cancel for the host and then answer gone', async () => {
    const { dispatch, requestId, digest } = await served();

    const cancelled = await dispatch.dispatch(post(path(requestId, 'cancel'), {}));
    const after = await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody(digest)));

    should(cancelled.status).equal(200);
    should(jsonBody(cancelled).state).equal('cancelled');
    should(after.status).equal(410);
  });

  it('should refuse a cancel body that carries anything', async () => {
    const { dispatch, requestId } = await served();

    const response = await dispatch.dispatch(post(path(requestId, 'cancel'), { value: VALUE }));

    should(response.status).equal(400);
    should(response.body).not.containEql(VALUE);
  });

  it('should refuse a session id or request id that is not usable', async () => {
    const { dispatch, requestId, digest } = await served();

    const badSession = await dispatch.dispatch(
      post(`/v1/sessions/-bad/input-requests/${requestId}/deliver`, deliverBody(digest)),
    );
    const badRequest = await dispatch.dispatch(post(path('not-hex', 'deliver'), deliverBody(digest)));
    const badList = await dispatch.dispatch(
      request({ method: 'GET', path: '/v1/sessions/-bad/input-requests', headers: human }),
    );

    should([badSession.status, badRequest.status, badList.status]).eql([400, 400, 400]);
  });

  it('should let a failure that is not an input refusal through as a server error', async () => {
    const { dispatch, requestId, digest } = await served(true);

    const response = await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody(digest)));

    should(response.status).equal(500);
    should(response.body).not.containEql(VALUE);
  });
});

describe('the quarantine routes', () => {
  const list = (headers: Readonly<Record<string, string>> = human) =>
    request({ method: 'GET', path: `/v1/sessions/${SESSION}/input-quarantines`, headers });
  const end = (key: string, headers: Readonly<Record<string, string>> = human) =>
    post(`/v1/sessions/${SESSION}/input-quarantines/${key}/end`, {}, headers);

  it('should list a quarantine once a secret was typed, and end it for the owner', async () => {
    const { dispatch, requestId, digest } = await served();
    await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody(digest)));

    const held = await dispatch.dispatch(list());
    const ended = await dispatch.dispatch(end('dev'));
    const after = await dispatch.dispatch(list());
    const again = await dispatch.dispatch(end('dev'));

    should(held.status).equal(200);
    should((jsonBody(held).quarantines as { key: string }[]).map(entry => entry.key)).eql(['dev']);
    should(ended.status).equal(200);
    should(jsonBody(after).quarantines).eql([]);
    should(again.status).equal(404);
  });

  it('should refuse an agent on both routes', async () => {
    const { dispatch, requestId, digest } = await served();
    await dispatch.dispatch(post(path(requestId, 'deliver'), deliverBody(digest)));

    const read = await dispatch.dispatch(list(agentIn(SESSION)));
    const stop = await dispatch.dispatch(end('dev', agentIn(SESSION)));

    should([read.status, stop.status]).eql([403, 403]);
  });
});

describe('the owner request list — publication at the transport', () => {
  const CANARY = 'pane-consumer-CANARY';

  it('should mask the facts of a terminal a hold took after the service last checked', async () => {
    const { service, quarantine } = inputRequestService({
      facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY }, promptLine: 'pane-prompt-CANARY' },
      names: ['dev', '000000000001'],
    });
    await service.raise(SESSION, RAISE);
    const list = service.list.bind(service);
    service.list = async (...args: Parameters<typeof list>) => {
      const answered = await list(...args);
      queueMicrotask(() => void quarantine.begin(SESSION, ['dev', '000000000001'], 'race'));
      return answered;
    };
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    const answered = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));

    should(answered.status).equal(200);
    should(String(answered.body)).not.containEql(CANARY);
    should(String(answered.body)).not.containEql('pane-prompt-CANARY');
    should(String(answered.body)).containEql('sudo wants your password');
  });

  it('should mask the facts of a terminal a hold took after the route last sealed them', async () => {
    const { service, quarantine } = inputRequestService({
      facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY }, promptLine: 'pane-prompt-CANARY' },
      names: ['dev', '000000000001'],
    });
    await service.raise(SESSION, RAISE);
    const until = service.quarantinedUntil.bind(service);
    let checked = false;
    service.quarantinedUntil = (...args: Parameters<typeof until>) => {
      const end = until(...args);
      if (!checked) {
        checked = true;
        queueMicrotask(() => void quarantine.begin(SESSION, ['dev', '000000000001'], 'late'));
      }
      return end;
    };
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    const answered = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));

    should(answered.status).equal(200);
    should(answered.late).be.undefined();
    should(String(answered.body)).not.containEql(CANARY);
    should(String(answered.body)).not.containEql('pane-prompt-CANARY');
  });

  it('should leave the facts of a terminal that is not quarantined as they are', async () => {
    const { service } = inputRequestService({ facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY } } });
    await service.raise(SESSION, RAISE);
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    const answered = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));

    should(String(answered.body)).containEql(CANARY);
  });
});
