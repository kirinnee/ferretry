import { describe, it } from 'bun:test';
import should from 'should';
import {
  ferretryNotice,
  PEER_MESSAGE_KINDS,
  parseFerretryNotice,
  parsePeerEnvelope,
  peerEnvelopePreamble,
  splitFerretryNotice,
} from '../../src/lib/agent-messages.ts';

describe('the peer envelope', () => {
  it('should write the short note banner the receiving ferret reads', () => {
    should(
      peerEnvelopePreamble({ name: 'torrey', sessionId: 'mvb0sw7d-27f71326', kind: 'message', clientName: 'fy' }),
    ).equal(
      '[message from ferret torrey (session mvb0sw7d-27f71326) — not from the owner]\n' +
        'To reply: fy send torrey "<reply>"\n\n',
    );
  });

  it('should never tell the receiver of a note or a reply that no answer is owed', () => {
    for (const kind of PEER_MESSAGE_KINDS) {
      const preamble = peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', kind, clientName: 'fy' });
      should(preamble).not.match(/no reply needed/iu);
    }
  });

  it('should say a question is waiting on its answer', () => {
    should(peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', kind: 'question', clientName: 'fy' })).equal(
      '[question from ferret torrey (session s1) — not from the owner]\n' +
        'torrey is waiting for your answer. Reply with: fy send torrey "<reply>"\n\n',
    );
  });

  it('should call a reply a reply', () => {
    should(peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', kind: 'reply', clientName: 'fy' })).startWith(
      '[reply from ferret torrey (session s1) — not from the owner]\nTo reply: fy send torrey',
    );
  });

  it('should keep the owner-facing vocabulary out of what the agent reads', () => {
    for (const kind of PEER_MESSAGE_KINDS) {
      const preamble = peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', kind, clientName: 'fy' });
      should(preamble).not.match(/teammate|human lead|PARKED/u);
    }
  });

  it('should read back exactly what it wrote, every kind', () => {
    for (const kind of PEER_MESSAGE_KINDS) {
      const preamble = peerEnvelopePreamble({ name: 'torrey', sessionId: 's1', kind, clientName: 'fy' });
      const parsed = parsePeerEnvelope(`${preamble}Hey! How's your day going?`);
      should(parsed?.body).equal("Hey! How's your day going?");
      should(parsed?.envelope).deepEqual({
        name: 'torrey',
        sessionId: 's1',
        kind,
        replyExpected: kind === 'question',
        note: preamble.split('\n')[1],
      });
    }
  });

  it('should still read the banner an older daemon wrote, both ways', () => {
    const note = 'No reply is required; torrey has carried on. Reply with `fy send torrey "…"` if useful.';
    should(
      parsePeerEnvelope(
        `[peer message from teammate torrey (session mvb0sw7d-27f71326) — not from the human lead]\n${note}\n\nhi`,
      ),
    ).deepEqual({
      envelope: { name: 'torrey', sessionId: 'mvb0sw7d-27f71326', kind: 'message', replyExpected: false, note },
      body: 'hi',
    });
    const parked = 'torrey is PARKED waiting for your reply and cannot continue until it arrives.';
    should(
      parsePeerEnvelope(`[peer message from teammate torrey (session s1) — not from the human lead]\n${parked}\n\nq?`)
        ?.envelope,
    ).deepEqual({ name: 'torrey', sessionId: 's1', kind: 'question', replyExpected: true, note: parked });
  });

  it('should read an older banner that names no session', () => {
    should(parsePeerEnvelope('[peer message from teammate nero]\nFYI\n\nthe rail landed')).deepEqual({
      envelope: { name: 'nero', kind: 'message', replyExpected: false, note: 'FYI' },
      body: 'the rail landed',
    });
  });

  it('should leave anything else alone', () => {
    should(parsePeerEnvelope('hello')).be.null();
    should(parsePeerEnvelope('[peer message from an unknown shape]\nbody')).be.null();
    should(parsePeerEnvelope('[note from ferret nero]\nFYI\n\nbody')).be.null();
    // A banner with no blank line after its note is not one this parser may strip.
    should(parsePeerEnvelope('[peer message from teammate nero]\nFYI')).be.null();
    should(parsePeerEnvelope('[message from ferret nero]\nFYI')).be.null();
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

  it('should split the headline from what is addressed to the agent', () => {
    should(splitFerretryNotice('Restarted.\n\nRead the file.\n\nThen carry on.')).eql({
      headline: 'Restarted.',
      details: 'Read the file.\n\nThen carry on.',
    });
    should(splitFerretryNotice('Your message did not arrive.')).eql({
      headline: 'Your message did not arrive.',
      details: null,
    });
  });
});
