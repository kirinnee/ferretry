import { describe, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import { PAIRING_REDIRECT_PAGE_MAX_CHARS } from '../../../../contract/index.ts';
import { type PairingRedirectWriter, pairingRedirectRoutes } from '../../../../daemon/lib/routes/pairing-redirect.ts';
import manifest from '../../../../manifest.ts';
import { jsonBody, respond } from '../../../support/daemon/call.ts';

const KEY = 'POST /v1/pair/redirect';
const send = (page: unknown) => JSON.stringify({ page });

/** A writer that records every page it was asked for and answers `answer` (or throws it). */
function writer(answer: string | Error) {
  const pages: string[] = [];
  const subject: PairingRedirectWriter = {
    write: async page => {
      pages.push(page);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { subject, pages };
}

describe('POST /v1/pair/redirect', () => {
  it('should be declared as the host admin credential alone, answered no-store', () => {
    const declared = manifest.actions.routes.find(route => route.key === KEY);
    should(declared?.minimum).equal('admin-token');
    should(declared?.noStore).equal(true);
    should(pairingRedirectRoutes(writer('x').subject).map(route => `${route.method} ${route.path}`)).eql([KEY]);
    const [route] = pairingRedirectRoutes(writer('x').subject);
    should(route?.minimum).equal(declared?.minimum);
    should(route?.noStore).equal(true);
    // The route table the kernel serves carries the same pin the manifest declares, so neither can drift.
    should(declared?.privilegedOnly).equal(true);
    should(route?.privilegedOnly).equal(true);
  });

  it('should have the writer make the page and answer only the directory it made', async () => {
    const { subject, pages } = writer('pair-open-AbCdEf');
    const response = await respond(pairingRedirectRoutes(subject), KEY, { host: true, body: send('<p>page</p>') });
    should(response.status).equal(201);
    should(jsonBody(response)).eql({ directory: 'pair-open-AbCdEf' });
    should(pages).eql(['<p>page</p>']);
  });

  it('should refuse a body that is not exactly one bounded page, before any page is made', async () => {
    const { subject, pages } = writer('pair-open-AbCdEf');
    const routes = pairingRedirectRoutes(subject);
    const refusals = [
      send(''),
      send(7),
      send('x'.repeat(PAIRING_REDIRECT_PAGE_MAX_CHARS + 1)),
      JSON.stringify({ page: 'ok', directory: '../escape' }),
      '{',
    ];
    for (const body of refusals) should((await respond(routes, KEY, { host: true, body })).status).equal(400);
    should(pages).eql([]);
  });

  it('should refuse a body larger than its bound without reading it all', async () => {
    const { subject, pages } = writer('pair-open-AbCdEf');
    const big = send('x'.repeat(PAIRING_REDIRECT_PAGE_MAX_CHARS * 6 + 100));
    should((await respond(pairingRedirectRoutes(subject), KEY, { host: true, body: big })).status).equal(413);
    should(pages).eql([]);
  });

  it('should never answer a directory that is not the exact shape the sweep matches', async () => {
    const { subject } = writer('../../etc');
    const response = await respond(pairingRedirectRoutes(subject), KEY, { host: true, body: send('<p>x</p>') });
    should(response.status).equal(500);
    should(response.body).not.containEql('etc');
  });

  it("should pass on the state's own refusal, such as a private file that could not be pinned", async () => {
    const refusal = new ApiError(503, 'A private file of access could not be pinned.', 'private_unpinned');
    const response = await respond(pairingRedirectRoutes(writer(refusal).subject), KEY, {
      host: true,
      body: send('<p>x</p>'),
    });
    should(response.status).equal(503);
    should(jsonBody(response).code).equal('private_unpinned');
  });

  it('should say only that the page was not made when the disk fails, never a path', async () => {
    const response = await respond(
      pairingRedirectRoutes(writer(new Error('EACCES: /home/someone/state/access/pairing-redirects')).subject),
      KEY,
      { host: true, body: send('<p>x</p>') },
    );
    should(response.status).equal(500);
    should(jsonBody(response)).eql({
      error: 'the pairing page could not be made',
      code: 'pairing_redirect_failed',
    });
    should(response.body).not.containEql('/home');
  });
});
