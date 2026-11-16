import { describe, it } from 'bun:test';
import should from 'should';
import {
  FERRETRY_CHANNEL_SERVER,
  isFerretryChannelOrigin,
  unwrapFerretryChannel,
} from '../../../daemon/reader/lib/transcript/channel.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';
import { ClaudeObservedInputObserver } from '../../../daemon/reader/lib/transcript/observed-input.ts';

const BANNER = '[message from :lead · send s-1]';
const TEXT = `${BANNER}\nPlease look at the failing test.`;
const WRAPPED = `<channel source="ferretry" send_id="s-1" from="lead">\n${TEXT}\n</channel>`;
const OTHER = '<channel source="testchan" seq="1">\nPING\n</channel>';
const ORIGIN = { kind: 'channel', server: 'ferretry' };
const CONTEXT = { source: 'claude.jsonl', byteOffset: 7, byteLength: 40, observedAt: '2026-11-16T06:00:00.000Z' };

const channelUser = (content: unknown, overrides: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: 'u-channel',
  timestamp: '2026-11-16T06:02:39.331Z',
  message: { role: 'user', content },
  isMeta: true,
  origin: ORIGIN,
  ...overrides,
});

const channelDrain = (prompt: unknown, origin: unknown = ORIGIN) => ({
  type: 'attachment',
  uuid: 'a-channel',
  timestamp: '2026-11-16T06:05:12.100Z',
  attachment: {
    type: 'queued_command',
    prompt,
    commandMode: 'prompt',
    origin,
    isMeta: true,
    timestamp: '2026-11-16T06:05:05.818Z',
  },
});

describe('unwrapFerretryChannel', () => {
  it('should give the words inside a Ferretry channel wrapper, banner line included', () => {
    should(unwrapFerretryChannel(WRAPPED)).equal(TEXT);
    should(FERRETRY_CHANNEL_SERVER).equal('ferretry');
  });

  it('should leave another server’s wrapper, plain text and a source-less tag untouched', () => {
    should(unwrapFerretryChannel(OTHER)).be.undefined();
    should(unwrapFerretryChannel('just typed')).be.undefined();
    should(unwrapFerretryChannel('<channel>\nx\n</channel>')).be.undefined();
  });

  it('should read the first source as the server when a meta key repeats it', () => {
    should(unwrapFerretryChannel('<channel source="ferretry" source="other">\nA\n</channel>')).equal('A');
    should(unwrapFerretryChannel('<channel source="testchan" source="ferretry">\nA\n</channel>')).be.undefined();
  });

  it('should keep markup and entities inside the words exactly as written', () => {
    const words = `${BANNER}\nUse <b>&amp;</b> and "quotes" </channel-ish>`;
    should(unwrapFerretryChannel(`<channel source="ferretry" a="x>y">\n${words}\n</channel>`)).equal(words);
  });
});

describe('isFerretryChannelOrigin', () => {
  it('should be true only for a channel origin naming this server', () => {
    should(isFerretryChannelOrigin(ORIGIN)).be.true();
    should(isFerretryChannelOrigin({ kind: 'channel', server: 'testchan' })).be.false();
    should(isFerretryChannelOrigin({ kind: 'human', server: 'ferretry' })).be.false();
    should(isFerretryChannelOrigin(undefined)).be.false();
    should(isFerretryChannelOrigin('channel')).be.false();
  });
});

describe('ClaudeTranscriptParser — Ferretry channel', () => {
  const subject = new ClaudeTranscriptParser();

  it('should draw an idle channel record as a normal user message carrying the banner, not a harness record', () => {
    const actual = subject.parseRecord(channelUser(WRAPPED));

    should(actual.events).have.length(1);
    const [event] = actual.events;
    should(event).containEql({ kind: 'message', role: 'user', text: TEXT });
    should(event).not.have.property('inputSource');
  });

  it('should unwrap a channel record whose content is text blocks', () => {
    const actual = subject.parseRecord(channelUser([{ type: 'text', text: WRAPPED }]));

    should(actual.events[0]).containEql({ kind: 'message', text: TEXT });
    should(actual.events[0]).not.have.property('inputSource');
  });

  it('should draw the busy drain as a native-queue message with the wrapper off', () => {
    const actual = subject.parseRecord(channelDrain(WRAPPED));

    should(actual.events).have.length(1);
    should(actual.events[0]).containEql({ kind: 'message', role: 'user', text: TEXT, inputSource: 'native-queue' });
  });

  it('should unwrap a busy drain recorded as content blocks', () => {
    const actual = subject.parseRecord(channelDrain([WRAPPED, { type: 'text', text: 'and more' }]));

    should(actual.events[0]).containEql({ text: `${TEXT}\nand more` });
  });

  it('should leave another server’s channel record as the harness’s own, wrapper and all', () => {
    const idle = subject.parseRecord(channelUser(OTHER, { origin: { kind: 'channel', server: 'testchan' } }));
    const busy = subject.parseRecord(channelDrain(OTHER, { kind: 'channel', server: 'testchan' }));

    should(idle.events[0]).containEql({ text: OTHER, inputSource: 'harness' });
    should(busy.events).have.length(0);
  });

  it('should keep a channel record whose wrapper does not parse as it is', () => {
    const actual = subject.parseRecord(channelUser('plain words'));

    should(actual.events[0]).containEql({ text: 'plain words' });
  });

  it('should not unwrap a wrapper typed by a person (origin human)', () => {
    const actual = subject.parseRecord(channelUser(WRAPPED, { origin: { kind: 'human' }, isMeta: undefined }));

    should(actual.events[0]).containEql({ text: WRAPPED });
  });
});

describe('ClaudeObservedInputObserver — Ferretry channel', () => {
  it('should prove an idle channel entry as a normal user record with the words inside', () => {
    const subject = new ClaudeObservedInputObserver();

    const actual = subject.observe(channelUser(WRAPPED), CONTEXT);

    should(actual).have.length(1);
    should(actual[0]).containEql({ proof: 'normal-user-record', text: TEXT, observedAt: '2026-11-16T06:02:39.331Z' });
  });

  it('should leave another server’s wrapped record as the text Claude wrote', () => {
    const subject = new ClaudeObservedInputObserver();

    const actual = subject.observe(channelUser(OTHER, { origin: { kind: 'channel', server: 'testchan' } }), CONTEXT);

    should(actual[0]).containEql({ text: OTHER });
  });

  it('should prove the busy drain as native-queue-drain with the words inside, dated by the remove line', () => {
    const subject = new ClaudeObservedInputObserver();
    subject.observe(
      { type: 'queue-operation', operation: 'remove', content: WRAPPED, timestamp: '2026-11-16T06:05:12.067Z' },
      CONTEXT,
    );

    const actual = subject.observe(channelDrain(WRAPPED), CONTEXT);

    should(actual).have.length(1);
    should(actual[0]).containEql({
      proof: 'native-queue-drain',
      text: TEXT,
      observedAt: '2026-11-16T06:05:12.067Z',
      originatedAt: '2026-11-16T06:05:05.818Z',
    });
  });

  it('should not prove a drain from another server’s channel', () => {
    const subject = new ClaudeObservedInputObserver();

    should(subject.observe(channelDrain(OTHER, { kind: 'channel', server: 'testchan' }), CONTEXT)).deepEqual([]);
  });

  it('should show the enqueue and release lines as the same words, which is the receipt', () => {
    const subject = new ClaudeObservedInputObserver();
    const line = (operation: string, timestamp: string, content = WRAPPED) => ({
      type: 'queue-operation',
      operation,
      content,
      timestamp,
    });

    const hold = subject.observe(line('enqueue', '2026-11-16T06:05:05.818Z'), CONTEXT);
    const release = subject.observe(line('dequeue', '2026-11-16T06:05:05.830Z'), CONTEXT);
    const other = subject.observe(line('enqueue', '2026-11-16T06:05:06.000Z', OTHER), CONTEXT);

    should(hold[0]).containEql({ proof: 'native-queue-hold', text: TEXT, observedAt: '2026-11-16T06:05:05.818Z' });
    should(release[0]).containEql({ proof: 'native-queue-release', text: TEXT });
    should(other[0]).containEql({ proof: 'native-queue-hold', text: OTHER });
  });
});
