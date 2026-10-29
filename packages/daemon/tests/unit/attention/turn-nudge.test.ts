import { describe, it } from 'bun:test';
import should from 'should';
import {
  ATTENTION_NUDGE_MARK,
  ATTENTION_NUDGE_TAIL,
  type AttentionNudgePorts,
  AttentionTurnNudge,
  attentionNudge,
  attentionNudgeMessage,
  attentionNudgeSendId,
  type FinishedTurn,
  finishedTurn,
  isTurnEnd,
  type NudgeSubject,
} from '../../../src/lib/attention/turn-nudge.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const owner = (text: string): TranscriptEvent => ({ kind: 'message', harness: 'claude', role: 'user', text });
const said = (text: string, messageId?: string): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text,
  ...(messageId === undefined ? {} : { messageId }),
});
const call = (name: string, input: TranscriptEvent extends never ? never : unknown): TranscriptEvent =>
  ({ kind: 'tool-call', harness: 'claude', role: 'assistant', call: { id: name, name, input } }) as TranscriptEvent;
const result = (): TranscriptEvent => ({
  kind: 'tool-result',
  harness: 'claude',
  role: 'user',
  result: { callId: 'x', content: 'ok', isError: false },
});

const LEAD_REPLY =
  '**Done:** PR opened.\n\nNext steps:\n- You: run `hms` to apply the new skill\n- You: approve the deploy\n- Me: babysit CI';
const TOP: NudgeSubject = { parent: false, mode: 'auto' };

const turn = (overrides: Partial<FinishedTurn> = {}): FinishedTurn => ({
  opener: 'please ship it',
  reply: LEAD_REPLY,
  replyKey: 'k',
  raised: 0,
  ...overrides,
});

describe('finishedTurn', () => {
  it('should take the words after the last tool call, from the last user message on', () => {
    // Arrange
    const events = [
      owner('old'),
      said('old reply'),
      owner('ship it'),
      said('Working on it.'),
      call('Bash', { command: 'git push' }),
      result(),
      said('Pushed.', 'm1'),
      said(LEAD_REPLY, 'm1'),
    ];

    // Act
    const actual = finishedTurn(events);

    // Assert
    should(actual?.opener).equal('ship it');
    should(actual?.reply).equal(`Pushed.\n${LEAD_REPLY}`);
    should(actual?.raised).equal(0);
  });

  it('should count the turn’s own raising calls: the CLI under any binary, ask_owner and the question tool', () => {
    // Arrange
    const events = [
      owner('go'),
      call('Bash', { command: 'fy attention add "Approve the deploy?" --task' }),
      call('exec_command', { cmd: ['zz', 'attention', 'edit', 'A3'] }),
      call('mcp__ferretry__terminal_ask_owner', { name: 'dev' }),
      call('mcp__ferretry__browser_open', { name: 'app', askOwner: 'log in' }),
      call('AskUserQuestion', { questions: [] }),
      call('Bash', { command: 'fy attention ls' }),
      call('mcp__ferretry__browser_open', { name: 'app' }),
      result(),
      said(LEAD_REPLY),
    ];

    // Act
    const actual = finishedTurn(events);

    // Assert
    should(actual?.raised).equal(5);
  });

  it('should not count raising calls from an earlier turn', () => {
    // Arrange
    const events = [owner('a'), call('Bash', { command: 'fy attention add "x"' }), owner('b'), said(LEAD_REPLY)];

    // Act + Assert
    should(finishedTurn(events)?.raised).equal(0);
  });

  it('should not treat a harness record or a tool result as the turn’s opener', () => {
    // Arrange
    const events: TranscriptEvent[] = [
      owner('ship it'),
      { kind: 'message', harness: 'claude', role: 'user', text: 'task finished', inputSource: 'harness' },
      said(LEAD_REPLY),
      { kind: 'message', harness: 'claude', role: 'assistant', text: 'synthetic', inputSource: 'harness' },
    ];

    // Act
    const actual = finishedTurn(events);

    // Assert
    should(actual?.opener).equal('ship it');
    should(actual?.reply).equal(LEAD_REPLY);
  });

  it('should read a tail with no user message at all as one turn with no opener', () => {
    // Act
    const actual = finishedTurn([said(LEAD_REPLY)]);

    // Assert
    should(actual?.opener).equal('');
  });

  it('should have nothing to check when the turn ended on a tool or said nothing', () => {
    // Assert
    should(finishedTurn([owner('go'), said('Looking.'), call('Bash', { command: 'ls' })])).be.undefined();
    should(finishedTurn([owner('go'), said('   ')])).be.undefined();
    should(finishedTurn([])).be.undefined();
  });

  it('should name the reply by its message id when it has one, and by its words otherwise — stably', () => {
    // Act
    const byId = finishedTurn([owner('a'), said('x', 'msg-1')]);
    const sameId = finishedTurn([owner('b'), said('different words', 'msg-1')]);
    const byWords = finishedTurn([owner('a'), said('x')]);
    const sameWords = finishedTurn([owner('a'), said('x')]);
    const otherWords = finishedTurn([owner('a'), said('y')]);

    // Assert
    should(byId?.replyKey).equal(sameId?.replyKey);
    should(byWords?.replyKey).equal(sameWords?.replyKey);
    should(byWords?.replyKey).not.equal(otherWords?.replyKey);
    should(byId?.replyKey).match(/^[0-9a-f]{16}$/u);
  });

  it('should name the reply by its record or item id when it has no message id', () => {
    // Arrange
    const record: TranscriptEvent = { ...said('x'), recordId: 'r1' } as TranscriptEvent;
    const item: TranscriptEvent = { ...said('x'), itemId: 'i1' } as TranscriptEvent;

    // Act + Assert
    should(finishedTurn([record])?.replyKey).not.equal(finishedTurn([item])?.replyKey);
  });
});

describe('attentionNudge', () => {
  it('should nudge a top-level ferret whose reply asks the owner to act and raised nothing', () => {
    // Act
    const actual = attentionNudge(turn(), TOP, 'fy');

    // Assert
    should(actual?.asks).deepEqual(['run `hms` to apply the new skill', 'approve the deploy']);
    should(actual?.message.startsWith(ATTENTION_NUDGE_MARK)).be.true();
  });

  it('should stay quiet once the turn raised as many items as it asked for', () => {
    // Assert
    should(attentionNudge(turn({ raised: 2 }), TOP, 'fy')).be.undefined();
    should(attentionNudge(turn({ raised: 1 }), TOP, 'fy')?.message).containEql(
      'You raised 1 this turn; raise the rest.',
    );
  });

  it('should never nudge a sub-ferret: its reply goes to the ferret that started it', () => {
    // Assert
    should(attentionNudge(turn(), { parent: true, mode: 'auto' }, 'fy')).be.undefined();
  });

  it('should never nudge the turn a nudge started, so a reply to it ends the exchange', () => {
    // Assert
    should(attentionNudge(turn({ opener: `  ${ATTENTION_NUDGE_MARK} Your last reply…` }), TOP, 'fy')).be.undefined();
  });

  it('should stay quiet on "Next steps: none" and on a reply that lists only its own next steps', () => {
    // Assert
    should(attentionNudge(turn({ reply: 'Done.\n\nNext steps: none' }), TOP, 'fy')).be.undefined();
    should(
      attentionNudge(turn({ reply: 'Next steps:\n- Me: wait for CI\n- Me: report back' }), TOP, 'fy'),
    ).be.undefined();
  });
});

describe('attentionNudgeMessage', () => {
  it('should list each ask, say how to raise one under the binary’s name, and allow a reason not to', () => {
    // Act
    const actual = attentionNudgeMessage(['approve the deploy'], 0, 'auto', 'zz');

    // Assert
    should(actual).startWith(`${ATTENTION_NUDGE_MARK} Your last reply asked the owner to:\n- approve the deploy\n`);
    should(actual).containEql('`zz attention add --title "<what>" "<the ask>" --step …`');
    should(actual).containEql('say why not in one line');
    should(actual).not.containEql('question tool');
    should(actual).not.containEql('You raised');
  });

  it('should offer the question tool only to an interactive ferret, which has one', () => {
    // Assert
    should(attentionNudgeMessage(['x'], 0, 'interactive', 'fy')).containEql('or your question tool');
  });
});

describe('isTurnEnd', () => {
  it.each([
    ['turn.state', { from: 'working', to: 'your-turn' }, true],
    ['turn.state', { from: 'working', to: 'needs-input' }, false],
    ['turn.prompt', { to: 'your-turn' }, false],
    ['turn.state', null, false],
    ['turn.state', 'your-turn', false],
  ])('should read %s %j as a turn end: %s', (type, data, expected) => {
    // Assert
    should(isTurnEnd(type, data)).equal(expected);
  });
});

describe('AttentionTurnNudge', () => {
  const ports = (
    overrides: Partial<AttentionNudgePorts> = {},
  ): { ports: AttentionNudgePorts; sent: [string, string, string][]; recorded: unknown[]; tails: number[] } => {
    const sent: [string, string, string][] = [];
    const recorded: unknown[] = [];
    const tails: number[] = [];
    return {
      sent,
      recorded,
      tails,
      ports: {
        enabled: async () => true,
        subject: async () => TOP,
        tail: async (_id, limit) => {
          tails.push(limit);
          return [owner('ship it'), said(LEAD_REPLY, 'm-9')];
        },
        send: async (id, sendId, message) => {
          sent.push([id, sendId, message]);
        },
        record: async (id, asks) => {
          recorded.push([id, asks]);
        },
        ...overrides,
      },
    };
  };

  it('should send one nudge under a send id derived from the reply, and journal it', async () => {
    // Arrange
    const harness = ports();

    // Act
    const actual = await new AttentionTurnNudge(harness.ports, 'fy').check('s-1');

    // Assert
    should(actual).be.true();
    should(harness.tails).deepEqual([ATTENTION_NUDGE_TAIL]);
    should(harness.sent).have.length(1);
    should(harness.sent[0]?.[1]).equal(
      attentionNudgeSendId('s-1', finishedTurn([said(LEAD_REPLY, 'm-9')])?.replyKey ?? ''),
    );
    should(harness.recorded).deepEqual([['s-1', ['run `hms` to apply the new skill', 'approve the deploy']]]);
  });

  it('should send the same id for the same reply seen twice, so the send slice makes it one message', async () => {
    // Arrange
    const harness = ports();
    const nudge = new AttentionTurnNudge(harness.ports, 'fy');

    // Act
    await nudge.check('s-1');
    await nudge.check('s-1');

    // Assert
    should(harness.sent[0]?.[1]).equal(harness.sent[1]?.[1]);
  });

  it('should do nothing while the machine’s switch is off', async () => {
    // Arrange
    const harness = ports({ enabled: async () => false });

    // Act + Assert
    should(await new AttentionTurnNudge(harness.ports, 'fy').check('s-1')).be.false();
    should(harness.tails).be.empty();
  });

  it('should not read the transcript of a sub-ferret or of a session it cannot read', async () => {
    // Arrange
    const child = ports({ subject: async () => ({ parent: true, mode: 'auto' }) });
    const unreadable = ports({ subject: async () => undefined });

    // Act + Assert
    should(await new AttentionTurnNudge(child.ports, 'fy').check('s-1')).be.false();
    should(await new AttentionTurnNudge(unreadable.ports, 'fy').check('s-1')).be.false();
    should(child.tails.concat(unreadable.tails)).be.empty();
  });

  it('should send nothing when the turn has no reply or asks for nothing', async () => {
    // Arrange
    const silent = ports({ tail: async () => [owner('go'), call('Bash', { command: 'ls' })] });
    const done = ports({ tail: async () => [owner('go'), said('All done. Next steps: none')] });

    // Act + Assert
    should(await new AttentionTurnNudge(silent.ports, 'fy').check('s-1')).be.false();
    should(await new AttentionTurnNudge(done.ports, 'fy').check('s-1')).be.false();
    should(silent.sent.concat(done.sent)).be.empty();
  });
});
