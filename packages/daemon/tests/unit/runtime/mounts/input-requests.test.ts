import { describe, it } from 'bun:test';
import { type InputTargetFacts, padInputValue } from '@ferretry/protocol';
import should from 'should';
import type { CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { finalised } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import type { InputRequestService } from '../../../../src/lib/input-requests/service.ts';
import { inputRequestRoutes } from '../../../../src/lib/runtime/mounts/input-requests.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from '../../input-requests/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human, withoutGrant, withoutSecretsConfigure } from './support.ts';

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

  it('should refuse a deliver naming a 2FA key, and type nothing, until this daemon makes codes per key', async () => {
    const { dispatch, writes, requestId, digest } = await served();
    const body = {
      deliveryId: crypto.randomUUID(),
      observedDigest: digest,
      entry: 'SUDO_X',
      factor: 'tf_000000000001',
      submit: true,
    };

    const response = await dispatch.dispatch(post(path(requestId, 'deliver'), body));

    should(response.status).equal(400);
    should(jsonBody(response).code).equal('bad_request');
    should(writes).eql([]);
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

    // A card older than the request: answered so the client reads it again, and nothing is counted.
    should(stale.status).equal(409);
    should(jsonBody(stale).code).equal('target_rebound');
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

    const sent = finalised(answered);
    should(sent.status).equal(200);
    should(String(sent.body)).not.containEql(CANARY);
    should(String(sent.body)).not.containEql('pane-prompt-CANARY');
  });

  it('should mask the facts of a terminal a hold took after the dispatcher answered, before the carrier sent', async () => {
    const { service, quarantine } = inputRequestService({
      facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY }, promptLine: 'pane-prompt-CANARY' },
      names: ['dev', '000000000001'],
    });
    await service.raise(SESSION, RAISE);
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    const answered = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));
    await quarantine.begin(SESSION, ['dev', '000000000001'], 'typing');

    should(String(answered.body)).containEql(CANARY);
    should(String(finalised(answered).body)).not.containEql(CANARY);
    should(String(finalised(answered).body)).not.containEql('pane-prompt-CANARY');
  });

  it('should leave the facts of a terminal that is not quarantined as they are', async () => {
    const { service } = inputRequestService({ facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY } } });
    await service.raise(SESSION, RAISE);
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    const answered = await dispatch.dispatch(request({ method: 'GET', path: '/v1/input-requests', headers: human }));

    should(String(answered.body)).containEql(CANARY);
  });
});

describe('the picture of a page request', () => {
  const PAGE: InputTargetFacts = {
    kind: 'browser',
    pageId: 'page-1',
    origin: 'https://example.test',
    secure: true,
    navigationId: 'loader-1',
    fields: [
      {
        fieldId: 'password',
        frameOrigin: 'https://example.test',
        frameId: 'main',
        backendNodeId: 7,
        field: { tag: 'input', type: 'password' },
        box: { x: 0, y: 0, w: 10, h: 10 },
        visible: true,
      },
    ],
  };
  const SHOT = { pngBase64: 'iVBORw0KGgo=', clip: { x: 0, y: 0, w: 10, h: 10 } };
  const shotPath = (requestId: string) => `/v1/sessions/${SESSION}/input-requests/${requestId}/shot`;

  it('should serve the owner the picture taken before anything was typed, and refuse an agent', async () => {
    // Arrange
    const { service } = inputRequestService({ facts: PAGE, shot: SHOT });
    await service.raise(SESSION, {
      ...RAISE,
      target: { kind: 'browser', key: 'app' },
      sensitivity: undefined,
      fields: [{ id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e7' } }],
    });
    const [open] = await service.list({ kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' });
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, GRANTED);

    // Act
    const owner = await dispatch.dispatch(request({ method: 'GET', path: shotPath(open?.id ?? ''), headers: human }));
    const agent = await dispatch.dispatch(
      request({ method: 'GET', path: shotPath(open?.id ?? ''), headers: agentIn(SESSION) }),
    );

    // Assert
    should(open?.pictured).be.true();
    should(owner.status).equal(200);
    should(jsonBody(owner)).eql(SHOT);
    should(agent.status).equal(403);
  });

  it('should answer 404 for a request with no picture', async () => {
    // Arrange
    const { dispatch, requestId } = await served();

    // Act
    const response = await dispatch.dispatch(request({ method: 'GET', path: shotPath(requestId), headers: human }));

    // Assert
    should(response.status).equal(404);
  });
});

describe('allowing a paste into the secret store', () => {
  /** A service whose one request goes where the case says; it records each delivery and holds no value. */
  function store(kind: 'secret' | 'terminal' | 'browser', guard: CapabilityGuard) {
    const delivered: string[] = [];
    const service = {
      targetOf: () =>
        kind === 'secret' ? { kind, key: 'VERCEL_TOKEN' } : { kind, key: kind === 'browser' ? 'app' : 'dev' },
      deliver: async (_session: string, requestId: string) => {
        delivered.push(requestId);
        return { id: requestId, deliveryId: crypto.randomUUID(), state: 'delivered', submitted: false };
      },
    } as unknown as InputRequestService;
    const dispatch = new ApiDispatcher(new ApiRouter(inputRequestRoutes(service)), CREDENTIALS, guard);
    return { dispatch, delivered };
  }
  const allow = { deliveryId: crypto.randomUUID(), observedDigest: 'a'.repeat(64), sealed: true, submit: false };
  const REQUEST = 'c'.repeat(32);

  it('should need the secrets grant from a governed device as well as the terminal one, reading no body without it', async () => {
    const refused = store('secret', withoutSecretsConfigure('not-granted'));
    const reads = bodyReads();

    const response = await refused.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow, human, reads));

    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_not_granted');
    should(String(jsonBody(response).error)).containEql('changes the secret store');
    should(reads.consumed).be.false();
    should(refused.delivered).eql([]);
  });

  it('should ask a device for a passkey when its secrets grant wants one, naming the secrets demand', async () => {
    const asking = store('secret', withoutSecretsConfigure('step-up-required'));

    const response = await asking.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow));

    should(response.status).equal(403);
    should(jsonBody(response)).match({
      code: 'grant_step_up_required',
      demand: { capability: 'secrets', axis: 'configure' },
    });
    should(asking.delivered).eql([]);
  });

  it('should deliver a store paste for a caller holding the grant, and a terminal paste without it', async () => {
    const granted = store('secret', GRANTED);
    const terminal = store('terminal', withoutSecretsConfigure('not-granted'));

    const answers = [
      await granted.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow)),
      await terminal.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow)),
    ];

    should(answers.map(answer => answer.status)).eql([200, 200]);
    should([granted.delivered, terminal.delivered]).eql([[REQUEST], [REQUEST]]);
  });

  it('should need the browser grant to allow a value into a page, and not for a terminal', async () => {
    const page = store('browser', withoutGrant({ capability: 'browser', axis: 'use' }));
    const terminal = store('terminal', withoutGrant({ capability: 'browser', axis: 'use' }));
    const granted = store('browser', GRANTED);

    const answers = [
      await page.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow)),
      await terminal.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow)),
      await granted.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow)),
    ];

    should(answers.map(answer => answer.status)).eql([403, 200, 200]);
    should(String(jsonBody(answers[0] as never).error)).containEql('needs the browser permission');
    should([page.delivered.length, terminal.delivered.length, granted.delivered.length]).eql([0, 1, 1]);
  });

  it('should refuse a store paste when the daemon cannot say who is asking', async () => {
    const blind = store('secret', { ...GRANTED, governance: () => undefined } as unknown as CapabilityGuard);

    const response = await blind.dispatch.dispatch(post(path(REQUEST, 'deliver'), allow));

    should(response.status).equal(403);
    should(blind.delivered).eql([]);
  });
});
