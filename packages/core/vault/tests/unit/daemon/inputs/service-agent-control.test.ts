import { describe, it } from 'bun:test';
import { agentControlRefusal, ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import type { ObserveResult } from '../../../../daemon/lib/inputs/ports.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { page, SESSION } from './grant-fixtures.ts';
import { AGENT, OWNER, PAGE_LOGIN, PASSWORD, refusal, USERNAME, world } from './world.ts';

/**
 * Ruling #42 SF1, TIGHTENED BY DESIGN: "What agents may control › Browsers" is read at Browsers' page target
 * (`PageInputTarget`), the one gate every write into a ferret's page passes, so the owner's Send on a page card raised
 * while Browsers was on is refused once it is off (today it typed whatever the switch said). The gate refuses in the
 * agents' sentence (`agentControlRefusal('browser')`); the Vault tells the OWNER in the owner's words, with the remedy,
 * and checks no switch itself. Nothing is typed or held, and the card is pending again, so it can be sent once Browsers
 * is back on. The fake target below throws exactly what the page target throws (browsers/daemon/target/adapter.ts).
 */

/** The owner's sentence, word for word (britnee's ruling on #42 SF1). */
const OWNER_SENTENCE =
  'Agents may no longer control browsers on this machine, so this card was not typed into the page. Turn on Browsers under What agents may control and try again, or dismiss the card.';

/** Today's agents' sentence, word for word (rebuild-ref agent-tools/policy.ts:96-101). */
const AGENTS_SENTENCE =
  'This machine does not let agents control browsers: "What agents may control › Browsers" is off in this machine\'s settings. Ask the person to turn it on if you need it.';

/** The owner's two typed values for the page login. */
const both = () => [
  { field: 'user', padded: padInputValue(USERNAME) },
  { field: 'pass', padded: padInputValue(PASSWORD) },
];

/** A page target behind the Browsers switch, as `PageInputTarget` is: a look while it is off throws the agents' refusal. */
function gatedPage() {
  const facts = page();
  const browsers = { on: true };
  const look = (): ObserveResult => {
    if (!browsers.on) throw new ApiError(403, agentControlRefusal('browser'), 'forbidden');
    return { ok: true, facts, names: ['page-1'] };
  };
  const w = world({ facts, observe: look, refind: look });
  return { w, browsers };
}

describe('#42 SF1 an owner Send on a page card while "What agents may control › Browsers" is off', () => {
  it('should refuse it in the owner’s words with the remedy, type and hold nothing, and leave the card pending to send again', async () => {
    // Arrange — the ferret raised the card while Browsers was on; then the owner turned it off.
    const { w, browsers } = gatedPage();
    await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();
    browsers.on = false;

    // Act
    const refused = await refusal(w.service.deliver(SESSION, request.id, w.send(request, { fields: both() }), OWNER));

    // Assert — the owner's sentence, not the agents' one, and no internals.
    should(refused.name).equal('InputRequestError');
    should(refused.code).equal('forbidden');
    should(refused.message).equal(OWNER_SENTENCE);
    should(refused.message).not.equal(AGENTS_SENTENCE);
    should(refused.message).not.containEql('Ask the person');
    should(w.writes).eql([]);
    should(w.quarantine.until(SESSION, ['~page:app', 'app', 'page-1'])).be.undefined();
    const after = await w.pending();
    should(after.id).equal(request.id);
    should(after.state).equal('pending');

    // Act — Browsers back on: the same card, sent again, types.
    browsers.on = true;
    const sent = await w.service.deliver(SESSION, request.id, w.send(after, { fields: both() }), OWNER);

    // Assert
    should(sent.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
  });

  it('should still refuse the agent’s raise in today’s agents’ sentence, unchanged (fail closed)', async () => {
    // Arrange
    const { w, browsers } = gatedPage();
    browsers.on = false;

    // Act
    const refused = await refusal(w.service.raise(SESSION, PAGE_LOGIN));

    // Assert — the agent path keeps the agents' sentence; the owner's is for the owner alone.
    should(refused).be.instanceOf(ApiError);
    should((refused as ApiError).status).equal(403);
    should(refused.code).equal('forbidden');
    should(refused.message).equal(AGENTS_SENTENCE);
    should(refused.message).not.equal(OWNER_SENTENCE);
    should(w.writes).eql([]);
    should(await w.service.list(OWNER, SESSION)).eql([]);
  });

  it('should tell the owner the same when Browsers goes off between the look and the write, not that the page is gone (N1)', async () => {
    // Arrange — the look passes; the page target's write finds the switch off and types nothing ('target_gone'), so the
    // Vault looks again, and that look is refused by the switch.
    const { w, browsers } = gatedPage();
    await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();
    w.state.typed = 'target_gone';
    w.state.onType = () => {
      browsers.on = false;
    };

    // Act
    const refused = await refusal(w.service.deliver(SESSION, request.id, w.send(request, { fields: both() }), OWNER));

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal(OWNER_SENTENCE);
    should((await w.pending()).state).equal('pending');
    should(w.quarantine.until(SESSION, ['~page:app', 'app', 'page-1'])).be.undefined();
  });

  it('should pass any other refusal through as it came: only the Browsers refusal is re-worded', async () => {
    const others: Record<string, Error> = {
      'another forbidden': new ApiError(403, 'some other refusal', 'forbidden'),
      'the sentence under another code': new ApiError(503, agentControlRefusal('browser'), 'unavailable'),
      'the sentence in no ApiError': new Error(agentControlRefusal('browser')),
      'the Terminals sentence': new ApiError(403, agentControlRefusal('terminal'), 'forbidden'),
    };
    for (const [why, other] of Object.entries(others)) {
      // Arrange — a page target that refuses with something else.
      let refuse = false;
      const facts = page();
      const w = world({
        facts,
        observe: () => {
          if (refuse) throw other;
          return { ok: true, facts, names: ['page-1'] };
        },
      });
      await w.service.raise(SESSION, PAGE_LOGIN);
      const request = await w.pending();
      refuse = true;

      // Act
      const refused = await refusal(w.service.deliver(SESSION, request.id, w.send(request, { fields: both() }), OWNER));

      // Assert
      should(refused).equal(other, why);
      should((await w.pending()).state).equal('pending', why);
    }
  });

  it('should refuse an agent at deliver before any target is asked, as before', async () => {
    // Arrange
    const { w } = gatedPage();
    await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();

    // Act
    const refused = await refusal(w.service.deliver(SESSION, request.id, w.send(request), AGENT));

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal('only the owner answers an input request; an agent cannot');
  });
});
