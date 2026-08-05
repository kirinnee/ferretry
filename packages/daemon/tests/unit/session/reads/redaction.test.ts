import { describe, it } from 'bun:test';
import should from 'should';
import { OperatorReadService, UNREDACTED, type OperatorReadRedactor } from '../../../../src/lib/session/reads/index.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * The three operator reads are the surfaces a person actually reads a session ON — the screen, the
 * transcript and the journal — so "a secret never appears in your transcripts" is a promise about
 * exactly this code path. These cases are its proof.
 *
 * The redactor here is a stand-in rather than the real vault: what is being asserted is that all
 * three reads GO THROUGH one, which is the thing a future change can silently break. What the real
 * redactor does with a value is proved in `tests/unit/secrets/`.
 */

const SECRET = 'sk-live-0123456789';
const INSTANT = '2026-02-01T09:08:07.000Z';

/** Masks the literal, and refuses everything when `damaged` — a vault that cannot be opened is a
 *  daemon that does not know what to scrub. */
const masking = (damaged = false): OperatorReadRedactor => ({
  redact: async text => {
    if (damaged) throw new Error('the vault could not be opened');
    return text.split(SECRET).join('[redacted:TOKEN]');
  },
  redactData: async value => {
    if (damaged) throw new Error('the vault could not be opened');
    return JSON.parse(JSON.stringify(value).split(SECRET).join('[redacted:TOKEN]')) as unknown;
  },
});

const message = (text: string): TranscriptEvent =>
  ({
    kind: 'message',
    harness: 'claude',
    role: 'assistant',
    timestamp: INSTANT,
    text,
  }) as TranscriptEvent;

const service = (redactor: OperatorReadRedactor, paneText = `screen ${SECRET}`): OperatorReadService =>
  new OperatorReadService(
    {
      replay: async () => [
        { sequence: 1, sessionId: 's1', time: INSTANT, type: 'tool.result', data: { output: `got ${SECRET}` } },
      ],
    },
    { capture: async () => ({ alive: true, dead: false, text: paneText }) },
    { tail: async () => ({ kind: 'read', events: [message(`I ran it with ${SECRET}`)] }) },
    { read: async () => ({ kind: 'read', text: `final frame ${SECRET}` }) },
    redactor,
  );

describe('operator reads are scrubbed', () => {
  it('should mask a value in the live screen', async () => {
    // Act
    const screen = await service(masking()).snapshot('s1');

    // Assert
    should(screen).equal('screen [redacted:TOKEN]');
  });

  it('should mask a value in the stored final frame', async () => {
    should(await service(masking()).snapshot('s1', false)).equal('final frame [redacted:TOKEN]');
  });

  it('should mask a value in the transcript', async () => {
    // Act
    const transcript = await service(masking()).logs('s1', undefined);

    // Assert
    should(transcript).containEql('[redacted:TOKEN]');
    should(transcript).not.containEql(SECRET);
  });

  it('should mask a value in a journal page without disturbing the envelope', async () => {
    // Act
    const [event] = await service(masking()).events('s1', 0, undefined);

    // Assert — the daemon minted the envelope, so only `data` can carry a value.
    should(event?.sequence).equal(1);
    should(event?.type).equal('tool.result');
    should(event?.data).deepEqual({ output: 'got [redacted:TOKEN]' });
  });

  it('should refuse rather than serve text it could not scrub', async () => {
    // Act / Assert — serving the raw text with a warning would BE the leak.
    await service(masking(true))
      .snapshot('s1')
      .then(
        () => should.fail('', '', 'a read that cannot be scrubbed must not be answered'),
        (error: unknown) => should((error as Error).message).match(/vault/u),
      );
  });

  it('should pass everything through for a daemon with no store wired', async () => {
    // Act
    const screen = await service(UNREDACTED).snapshot('s1');

    // Assert — nothing to hide is a fact, not a fallback.
    should(screen).equal(`screen ${SECRET}`);
  });

  it('should scrub a turn-partitioned transcript too', async () => {
    // Arrange — the turn slice is a second return path, and a scrub applied to only one of them is
    // the shape of defect this file exists to catch.
    const partitioned = new OperatorReadService(
      { replay: async () => [] },
      { capture: async () => undefined },
      {
        tail: async () => ({
          kind: 'read',
          events: [
            { kind: 'turn', harness: 'claude', role: 'system', state: 'started' } as TranscriptEvent,
            message(`turn zero saw ${SECRET}`),
          ],
        }),
      },
      { read: async () => ({ kind: 'absent' }) },
      masking(),
    );

    // Act
    const text = await partitioned.logs('s1', undefined, 0);

    // Assert
    should(text).containEql('[redacted:TOKEN]');
    should(text).not.containEql(SECRET);
  });
});
