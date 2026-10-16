import { describe, it } from 'bun:test';
import should from 'should';
import {
  ferretryNotice,
  parseFerretryNotice,
  parsePeerEnvelope,
  peerEnvelopePreamble,
} from '../../src/lib/agent-messages.ts';

describe('the peer envelope', () => {
  it('should write the fire-and-forget banner the receiving agent reads', () => {
    should(
      peerEnvelopePreamble({ name: 'torrey', sessionId: 'mvb0sw7d-27f71326', replyExpected: false, clientName: 'fy' }),
    ).equal(
      '[peer message from teammate torrey (session mvb0sw7d-27f71326) — not from the human lead]\n' +
        'No reply is required; torrey has carried on. Reply with `fy send torrey "…"` if useful.\n\n',
    );
  });

  it('should write the parked banner with the reply instruction', () => {
    should(peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', replyExpected: true, clientName: 'fy' })).equal(
      '[peer message from teammate torrey (session s1) — not from the human lead]\n' +
        'torrey is PARKED waiting for your reply and cannot continue until it arrives. ' +
        'Answer with: fy send torrey "<your reply>"\n\n',
    );
  });

  it('should read back exactly what it wrote, both ways', () => {
    for (const replyExpected of [false, true]) {
      const preamble = peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', replyExpected, clientName: 'fy' });
      const parsed = parsePeerEnvelope(`${preamble}Hey! How's your day going?`);
      should(parsed?.body).equal("Hey! How's your day going?");
      should(parsed?.envelope).deepEqual({
        name: 'torrey',
        sessionId: 's1',
        replyExpected,
        note: preamble.split('\n')[1],
      });
    }
  });

  it('should read an older banner that names no session', () => {
    should(parsePeerEnvelope('[peer message from teammate nero]\nFYI\n\nthe rail landed')).deepEqual({
      envelope: { name: 'nero', replyExpected: false, note: 'FYI' },
      body: 'the rail landed',
    });
  });

  it('should leave anything else alone', () => {
    should(parsePeerEnvelope('hello')).be.null();
    should(parsePeerEnvelope('[peer message from an unknown shape]\nbody')).be.null();
    // A banner with no blank line after its note is not one this parser may strip.
    should(parsePeerEnvelope('[peer message from teammate nero]\nFYI')).be.null();
  });
});

describe('Ferretry notices', () => {
  it('should tag a notice and read the tag back off', () => {
    const notice = ferretryNotice('Your message to aniya did not reach it.');
    should(notice).equal('[ferretry] Your message to aniya did not reach it.');
    should(parseFerretryNotice(notice)).equal('Your message to aniya did not reach it.');
    should(parseFerretryNotice(`\n  ${notice}\n`)).equal('Your message to aniya did not reach it.');
  });

  it('should not claim ordinary text or an empty notice', () => {
    should(parseFerretryNotice('ferretry is great')).be.null();
    should(parseFerretryNotice('[ferretry]   ')).be.null();
  });
});
