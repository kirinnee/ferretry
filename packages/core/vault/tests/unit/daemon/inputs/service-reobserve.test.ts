import { describe, it } from 'bun:test';
import should from 'should';
import type { InputDeliverBody, InputTargetFacts } from '../../../../contract/index.ts';
import { InputRequestError } from '../../../../daemon/lib/inputs/errors.ts';
import type { InputCaller } from '../../../../daemon/lib/inputs/ports.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from './support.ts';

/**
 * `reobserve` is the card's "look at the target again": the Send guard's own look, run on request, so a card that has sat
 * open is redrawn from what the target shows now BEFORE the owner types (B5-B3 review item 4). It types nothing, counts
 * nothing and returns the request as the list does, never a value.
 */

const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };
const VALUE = 'hunter2-UNIQUE';

const bodyFor = (digest: string): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(VALUE),
  submit: true,
});

/** A terminal whose prompt can move down a row (a redraw of the SAME target) or be replaced by another program. */
async function raised() {
  const shown: { facts: InputTargetFacts } = { facts: FACTS };
  const built = inputRequestService({ facts: () => shown.facts });
  await built.service.raise(SESSION, RAISE);
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, shown, id: request.id, digest: request.observedDigest ?? '' };
}

const refused = async (promise: Promise<unknown>): Promise<InputRequestError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InputRequestError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('InputRequestService.reobserve', () => {
  it('should redraw a target that moved, so the Send that follows is not refused as target_rebound', async () => {
    const { service, shown, id, digest, writes } = await raised();
    shown.facts = { ...FACTS, cursorRow: FACTS.cursorRow + 1 };

    // The list answers held facts only: it has not seen the redraw.
    should((await service.list(HOST))[0]?.observedDigest).equal(digest);
    const looked = await service.reobserve(SESSION, id, HOST);

    should(looked.observedDigest).not.equal(digest);
    should(looked.state).equal('pending');
    should((await service.list(HOST))[0]?.observedDigest).equal(looked.observedDigest);
    const result = await service.deliver(SESSION, id, bodyFor(looked.observedDigest ?? ''), HOST);
    should(result.state).equal('delivered');
    should(writes).eql([VALUE]);
  });

  it('should leave a card whose target did not move exactly as it was', async () => {
    const { service, id, digest } = await raised();

    const looked = await service.reobserve(SESSION, id, HOST);

    should(looked.observedDigest).equal(digest);
  });

  it('should leave a target that is another program as it was, count nothing, and let the Send refuse it', async () => {
    const { service, shown, id, digest, writes } = await raised();
    shown.facts = { ...FACTS, foreground: { ...FACTS.foreground, pid: 5100, comm: 'bash' }, program: 'bash' };

    for (let n = 0; n < 5; n += 1) should((await service.reobserve(SESSION, id, HOST)).observedDigest).equal(digest);

    // Five looks counted no failure: the request is still pending, and the Send is the one that refuses.
    should((await service.list(HOST))[0]?.state).equal('pending');
    should((await refused(service.deliver(SESSION, id, bodyFor(digest), HOST))).reason).equal('target_changed');
    should(writes).eql([]);
  });

  it('should not spend the Send’s redraw budget, however often the card is looked at again', async () => {
    const { service, shown, id } = await raised();

    for (let row = 1; row <= 6; row += 1) {
      shown.facts = { ...FACTS, cursorRow: FACTS.cursorRow + row };
      await service.reobserve(SESSION, id, HOST);
    }

    should((await service.list(HOST))[0]?.state).equal('pending');
  });

  it('should refuse an agent, another ferret’s request id and a request that has ended', async () => {
    const { service, id } = await raised();

    should((await refused(service.reobserve(SESSION, id, AGENT))).code).equal('forbidden');
    should((await refused(service.reobserve('another-ferret', id, HOST))).code).equal('not_found');
    should((await refused(service.reobserve(SESSION, 'f'.repeat(32), HOST))).code).equal('not_found');
    await service.cancel(SESSION, id, HOST);
    should((await refused(service.reobserve(SESSION, id, HOST))).code).equal('gone');
  });
});
