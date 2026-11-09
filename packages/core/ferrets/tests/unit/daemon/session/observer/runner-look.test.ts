import { describe, it } from 'bun:test';
import should from 'should';
import type { JsonValue } from '@ferretry/std';
import { turnPaneEvidenceOfLook } from '../../../../../daemon/adapters/session/observer/runner-look.ts';
import { maskedStrings, promptOf } from '../../../../../daemon/lib/ferrets/prompt.ts';
import { SessionStatusSchema } from '../../../../../contract/index.ts';
import { lifecycleStatus } from '../../../../../daemon/lib/ferrets/session-document.ts';

const REQUEST = {
  id: '0123456789abcdef',
  harness: 'claude',
  tool: 'Bash',
  action: 'run',
  what: 'curl -s https://example.com',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

describe('turnPaneEvidenceOfLook (Ferrets’ boundary over Runner.look)', () => {
  it('should keep what parses and drop a permission request or dialog its schema refuses', () => {
    // Arrange
    const look = {
      frame: 'f1',
      working: false,
      atPrompt: false,
      permission: true,
      prompt: 'x'.repeat(400),
      request: { ...REQUEST, selected: 9 } as JsonValue,
      dialog: { anything: 'at all' } as JsonValue,
    };

    // Act
    const evidence = turnPaneEvidenceOfLook(look);

    // Assert: the prompt flag survives, the refused values do not, the words are bounded.
    should(evidence.permission).be.true();
    should(evidence.request).be.undefined();
    should(evidence.dialog).be.undefined();
    should(evidence.prompt).have.length(300);
    should(evidence.frame).equal('f1');
  });

  it('should carry a request the schema accepts', () => {
    // Act
    const evidence = turnPaneEvidenceOfLook({
      frame: 'f2',
      working: false,
      atPrompt: false,
      permission: true,
      request: REQUEST as unknown as JsonValue,
    });

    // Assert
    should(evidence.request?.tool).equal('Bash');
  });
});

describe('promptOf (FerretsApi.prompt)', () => {
  it('should mask every string of the recorded prompt, permission request and dialog', () => {
    // Arrange
    const mask = (text: string) => text.replaceAll('example.com', '***********');

    // Act
    const prompt = promptOf(
      { turnState: 'needs-input', turnPrompt: 'trust example.com?', permissionRequest: REQUEST as never },
      mask,
    );

    // Assert
    should(prompt.turnState).equal('needs-input');
    should(prompt.prompt).equal('trust ***********?');
    should(JSON.stringify(prompt)).not.containEql('example.com');
    should(promptOf({}, mask)).deepEqual({});
  });

  it('should keep the shape and every non-string of a value it masks', () => {
    // Act
    const masked = maskedStrings({ a: [1, true, null, 'secret'], b: { c: 'secret' } }, text => text.toUpperCase());

    // Assert
    should(masked).deepEqual({ A: [1, true, null, 'SECRET'], B: { C: 'SECRET' } });
  });
});

describe('lifecycleStatus (the state document follows the ferret’s lifecycle)', () => {
  it('should follow only the lifecycle edges and leave every status something else decided', () => {
    // Act
    const answers = [
      lifecycleStatus('starting', 'working'),
      lifecycleStatus('starting', 'idle'),
      lifecycleStatus('created', 'working'),
      lifecycleStatus('stopped', 'starting'),
      lifecycleStatus('running', 'stopped'),
      lifecycleStatus('rate_limited', 'stopped'),
      lifecycleStatus('running', 'idle'),
      lifecycleStatus('rate_limited', 'working'),
      lifecycleStatus('awaiting_question', 'idle'),
      lifecycleStatus('kill_failed', 'stopped'),
    ];

    // Assert
    should(answers).deepEqual([
      'running',
      'running',
      'running',
      'starting',
      'stopped',
      'stopped',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('should move every status by the one revive rule on each lifecycle edge, and never clear kill_failed', () => {
    // Arrange: what each status moves to on [starting, working, idle, stopped]; `-` leaves it as it is.
    const expected: Record<string, readonly string[]> = {
      created: ['-', 'running', 'running', 'stopped'],
      starting: ['-', 'running', 'running', 'stopped'],
      retrying: ['-', 'running', 'running', 'stopped'],
      running: ['-', '-', '-', 'stopped'],
      thinking: ['-', '-', '-', 'stopped'],
      tool_running: ['-', '-', '-', 'stopped'],
      awaiting_question: ['-', '-', '-', 'stopped'],
      awaiting_user: ['-', '-', '-', 'stopped'],
      interrupted: ['-', '-', '-', 'stopped'],
      rate_limited: ['-', '-', '-', 'stopped'],
      waiting: ['-', '-', '-', 'stopped'],
      // Revivable (`reviveRuling`): a revive brings each back, and the ferret is watched again.
      // Revived only by the start edge (proof of a new run); a plain turn edge never revives them (BG-039).
      completed: ['starting', '-', '-', '-'],
      failed: ['starting', '-', '-', '-'],
      stalled: ['starting', '-', '-', '-'],
      stopped: ['starting', '-', '-', '-'],
      // An unconfirmed stop: no registry edge confirms one, so none clears it.
      kill_failed: ['-', '-', '-', '-'],
    };

    // Act
    const answers = Object.fromEntries(
      SessionStatusSchema.options.map(status => [
        status,
        (['starting', 'working', 'idle', 'stopped'] as const).map(edge => lifecycleStatus(status, edge) ?? '-'),
      ]),
    );

    // Assert: every status is in the table (a new one must be decided here), and each moves as the table says.
    should(Object.keys(expected).sort()).deepEqual([...SessionStatusSchema.options].sort());
    should(answers).deepEqual(expected);
  });

  describe('BG-039 an ended document revives only on proof of a new live run', () => {
    const ENDED = ['completed', 'failed', 'stalled', 'stopped'] as const;

    for (const status of ENDED) {
      it(`should revive a ${status} document on the lifecycle start edge (a start, resume or fork launch)`, () => {
        should(lifecycleStatus(status, 'starting', 'lifecycle')).equal('starting');
        should(lifecycleStatus(status, 'starting')).equal('starting');
      });

      it(`should leave a ${status} document ended on a stale registry (a reconcile), whatever state the registry reads`, () => {
        for (const state of ['starting', 'working', 'idle'] as const)
          should(lifecycleStatus(status, state, 'reconcile')).be.undefined();
      });

      it(`should leave a ${status} document ended on a plain turn edge (working or idle), which is no new run`, () => {
        should(lifecycleStatus(status, 'working', 'lifecycle')).be.undefined();
        should(lifecycleStatus(status, 'idle', 'lifecycle')).be.undefined();
      });
    }

    it('should never revive kill_failed on any edge or cause: its last stop is unconfirmed (today moves it only to stopped)', () => {
      for (const cause of ['lifecycle', 'reconcile'] as const)
        for (const state of ['starting', 'working', 'idle', 'stopped'] as const)
          should(lifecycleStatus('kill_failed', state, cause)).be.undefined();
    });

    it('should still repair a document a crash left on its way up, from a reconcile', () => {
      for (const status of ['created', 'starting', 'retrying'] as const) {
        should(lifecycleStatus(status, 'working', 'reconcile')).equal('running');
        should(lifecycleStatus(status, 'idle', 'reconcile')).equal('running');
      }
    });

    it('should revive and then follow the run: starting edge, then a turn edge gives running', () => {
      const revived = lifecycleStatus('failed', 'starting', 'lifecycle');
      should(revived).equal('starting');
      should(lifecycleStatus(revived as 'starting', 'working', 'lifecycle')).equal('running');
    });
  });
});
