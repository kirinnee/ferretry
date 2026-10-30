import { describe, it } from 'bun:test';
import { type AlwaysOnSection, instructionDigest } from '@ferretry/fleet';
import type { SessionLaunchInstructions } from '@ferretry/protocol';
import should from 'should';
import {
  changedInstructions,
  INSTRUCTIONS_UPDATED_MARK,
  InstructionRefresh,
  type InstructionRefreshPorts,
  instructionsUpdatedNote,
  recordTold,
} from '../../../../src/lib/session/launch/instruction-refresh.ts';

const NOW: readonly AlwaysOnSection[] = [
  { id: 'tools', text: 'Tools: drive terminals.' },
  { id: 'settings', text: 'Settings: read the guide.' },
  { id: 'notify', text: 'Notify: tell the owner with a notice.' },
];

const told = (id: AlwaysOnSection['id'], text: string) => ({ id, chars: text.length, digest: instructionDigest(text) });

const launched = (notify: string): SessionLaunchInstructions => ({
  sections: [
    told('tools', 'Tools: drive terminals.'),
    told('settings', 'Settings: read the guide.'),
    told('notify', notify),
    { id: 'pack', chars: 40 },
  ],
  mode: 'auto',
  questions: false,
});

describe('changedInstructions', () => {
  it('should name only the always-on sections whose words changed since the launch', () => {
    // Act
    const actual = changedInstructions(launched('Notify: an older rule.'), NOW);

    // Assert
    should(actual.map(section => section.id)).deepEqual(['notify']);
  });

  it('should name nothing for a launch on the current words', () => {
    // Assert
    should(changedInstructions(launched('Notify: tell the owner with a notice.'), NOW)).be.empty();
  });

  it('should compare sizes for a record made before fingerprints were kept', () => {
    // Arrange
    const old: SessionLaunchInstructions = {
      sections: [
        { id: 'tools', chars: NOW[0]?.text.length ?? 0 },
        { id: 'settings', chars: 1 },
      ],
      mode: 'auto',
      questions: false,
    };

    // Act
    const actual = changedInstructions(old, NOW);

    // Assert — settings changed size; notify was never told at all.
    should(actual.map(section => section.id)).deepEqual(['settings', 'notify']);
  });

  it('should tell a session with no record nothing: nothing says what it has', () => {
    // Assert
    should(changedInstructions(undefined, NOW)).be.empty();
  });
});

describe('instructionsUpdatedNote', () => {
  it('should mark the note and carry each changed section whole', () => {
    // Act
    const actual = instructionsUpdatedNote(NOW.slice(1));

    // Assert
    should(actual).startWith(INSTRUCTIONS_UPDATED_MARK);
    should(actual).endWith('\n\nSettings: read the guide.\n\nNotify: tell the owner with a notice.');
  });
});

describe('recordTold', () => {
  it('should record the told sections as current, in prompt order, and keep the per-ferret ones as launched', () => {
    // Arrange
    const old: SessionLaunchInstructions = {
      sections: [{ id: 'pack', chars: 40 }, told('tools', 'Tools: drive terminals.')],
      mode: 'interactive',
      questions: true,
    };

    // Act
    const actual = recordTold(old, [NOW[2] as AlwaysOnSection, NOW[1] as AlwaysOnSection]);

    // Assert
    should(actual).deepEqual({
      sections: [
        told('tools', 'Tools: drive terminals.'),
        told('settings', 'Settings: read the guide.'),
        told('notify', 'Notify: tell the owner with a notice.'),
        { id: 'pack', chars: 40 },
      ],
      mode: 'interactive',
      questions: true,
    });
    should(changedInstructions(actual, NOW)).be.empty();
  });
});

describe('InstructionRefresh', () => {
  const harness = (
    recorded: SessionLaunchInstructions | undefined,
    failing: 'read' | 'write' | 'queue' | false = false,
  ) => {
    let stored = recorded;
    const queued: Array<{ sessionId: string; digest: string; note: string }> = [];
    const ports: InstructionRefreshPorts = {
      sections: () => NOW,
      recorded: async () => {
        if (failing === 'read') throw new Error('unreadable');
        return stored;
      },
      record: async (_id, update) => {
        if (failing === 'write') throw new Error('unwritable');
        stored = update(stored) ?? stored;
      },
      queue: async (sessionId, digest, note) => {
        if (failing === 'queue') throw new Error('outbox unwritable');
        queued.push({ sessionId, digest, note });
      },
    };
    return { refresh: new InstructionRefresh(ports), stored: () => stored, queued };
  };

  it('should queue the note once as its own message, then queue nothing on the next call', async () => {
    // Arrange
    const { refresh, stored, queued } = harness(launched('Notify: an older rule.'));

    // Act
    await refresh.queueIfStale('s-1');
    await refresh.queueIfStale('s-1');

    // Assert
    should(queued).have.length(1);
    should(queued[0]?.sessionId).equal('s-1');
    should(queued[0]?.note).startWith(INSTRUCTIONS_UPDATED_MARK);
    should(queued[0]?.note).endWith('Notify: tell the owner with a notice.');
    should(queued[0]?.digest).equal(instructionDigest(queued[0]?.note ?? ''));
    should(stored()?.sections.find(section => section.id === 'notify')?.digest).equal(
      instructionDigest('Notify: tell the owner with a notice.'),
    );
  });

  it('should queue nothing for a ferret on the current words', async () => {
    // Arrange
    const { refresh, queued } = harness(launched('Notify: tell the owner with a notice.'));

    // Act
    await refresh.queueIfStale('s-1');

    // Assert
    should(queued).be.empty();
  });

  it('should queue nothing, and never fail, when the record cannot be read', async () => {
    // Arrange
    const { refresh, queued } = harness(launched('old'), 'read');

    // Act + Assert
    await should(refresh.queueIfStale('s-1')).be.fulfilled();
    should(queued).be.empty();
  });

  it('should not record the note as told when it could not be queued, so the next message offers it again', async () => {
    // Arrange
    const { refresh, stored } = harness(launched('Notify: an older rule.'), 'queue');

    // Act
    await should(refresh.queueIfStale('s-1')).be.fulfilled();

    // Assert
    should(changedInstructions(stored(), NOW).map(section => section.id)).deepEqual(['notify']);
  });

  it('should never fail when the record cannot be written, and write nothing for a vanished record', async () => {
    // Arrange
    const unwritable = harness(launched('old'), 'write');
    const vanished = harness(undefined);

    // Act
    await should(unwritable.refresh.queueIfStale('s-1')).be.fulfilled();
    await vanished.refresh.queueIfStale('s-1');

    // Assert
    should(unwritable.queued).have.length(1);
    should(vanished.stored()).be.undefined();
  });
});

describe('InstructionRefresh for a sub-ferret', () => {
  const SUB: readonly AlwaysOnSection[] = [
    { id: 'tools', text: 'Tools: drive terminals.' },
    { id: 'settings', text: 'Settings: read the guide.' },
    { id: 'sub-ferret', text: 'Sub-ferret: report to your lead.' },
  ];

  const recordedSub = (text: string): SessionLaunchInstructions => ({
    sections: [
      told('tools', 'Tools: drive terminals.'),
      told('settings', 'Settings: read the guide.'),
      told('sub-ferret', text),
    ],
    mode: 'auto',
    questions: false,
  });

  it('should compare a sub-ferret record against the sub-ferret sections, not the lead ones', async () => {
    // Arrange
    const asked: boolean[] = [];
    const queued: string[] = [];
    const refresh = new InstructionRefresh({
      sections: subFerret => {
        asked.push(subFerret);
        return subFerret ? SUB : NOW;
      },
      recorded: async () => recordedSub('Sub-ferret: report to your lead.'),
      record: async () => undefined,
      queue: async (_id, _digest, note) => {
        queued.push(note);
      },
    });

    // Act
    await refresh.queueIfStale('s-1');

    // Assert — current words, so nothing is queued, and the sub-ferret layer was the one asked for.
    should(asked).deepEqual([true]);
    should(queued).be.empty();
  });

  it('should tell a sub-ferret only its own changed section, never the lead notify and board rules', async () => {
    // Arrange
    const queued: string[] = [];
    const refresh = new InstructionRefresh({
      sections: subFerret => (subFerret ? SUB : NOW),
      recorded: async () => recordedSub('Sub-ferret: an older rule.'),
      record: async () => undefined,
      queue: async (_id, _digest, note) => {
        queued.push(note);
      },
    });

    // Act
    await refresh.queueIfStale('s-1');

    // Assert
    should(queued).have.length(1);
    should(queued[0]).endWith('Sub-ferret: report to your lead.');
    should(queued[0]).not.containEql('Notify:');
  });
});
