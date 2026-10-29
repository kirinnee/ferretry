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
  { id: 'attention', text: 'Attention: raise every ask as an item.' },
];

const told = (id: AlwaysOnSection['id'], text: string) => ({ id, chars: text.length, digest: instructionDigest(text) });

const launched = (attention: string): SessionLaunchInstructions => ({
  sections: [
    told('tools', 'Tools: drive terminals.'),
    told('settings', 'Settings: read the guide.'),
    told('attention', attention),
    { id: 'pack', chars: 40 },
  ],
  mode: 'auto',
  questions: false,
});

describe('changedInstructions', () => {
  it('should name only the always-on sections whose words changed since the launch', () => {
    // Act
    const actual = changedInstructions(launched('Attention: an older rule.'), NOW);

    // Assert
    should(actual.map(section => section.id)).deepEqual(['attention']);
  });

  it('should name nothing for a launch on the current words', () => {
    // Assert
    should(changedInstructions(launched('Attention: raise every ask as an item.'), NOW)).be.empty();
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

    // Assert — settings changed size; attention was never told at all.
    should(actual.map(section => section.id)).deepEqual(['settings', 'attention']);
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
    should(actual).endWith('\n\nSettings: read the guide.\n\nAttention: raise every ask as an item.');
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
        told('attention', 'Attention: raise every ask as an item.'),
        { id: 'pack', chars: 40 },
      ],
      mode: 'interactive',
      questions: true,
    });
    should(changedInstructions(actual, NOW)).be.empty();
  });
});

describe('InstructionRefresh', () => {
  const harness = (recorded: SessionLaunchInstructions | undefined, failing = false) => {
    let stored = recorded;
    const ports: InstructionRefreshPorts = {
      sections: () => NOW,
      recorded: async () => {
        if (failing) throw new Error('unreadable');
        return stored;
      },
      record: async (_id, update) => {
        if (failing) throw new Error('unwritable');
        stored = update(stored) ?? stored;
      },
    };
    return { refresh: new InstructionRefresh(ports), stored: () => stored };
  };

  it('should append the note to the owner’s next message once, then carry nothing', async () => {
    // Arrange
    const { refresh, stored } = harness(launched('Attention: an older rule.'));

    // Act
    const first = await refresh.prepare('s-1', 'please continue');
    await refresh.settle('s-1', first);
    const second = await refresh.prepare('s-1', 'and then this');

    // Assert
    should(first.message).startWith(`please continue\n\n${INSTRUCTIONS_UPDATED_MARK}`);
    should(first.message).endWith('Attention: raise every ask as an item.');
    should(second).deepEqual({ message: 'and then this', told: [] });
    should(stored()?.sections.find(section => section.id === 'attention')?.digest).equal(
      instructionDigest('Attention: raise every ask as an item.'),
    );
  });

  it('should leave the message as written when the record cannot be read, and never fail a settle', async () => {
    // Arrange
    const { refresh } = harness(launched('old'), true);

    // Act
    const actual = await refresh.prepare('s-1', 'hello');
    await refresh.settle('s-1', { message: 'hello', told: NOW });

    // Assert
    should(actual).deepEqual({ message: 'hello', told: [] });
  });

  it('should write nothing when nothing was told, or the record vanished meanwhile', async () => {
    // Arrange
    const quiet = harness(launched('Attention: raise every ask as an item.'));
    const vanished = harness(undefined);

    // Act
    await quiet.refresh.settle('s-1', { message: 'x', told: [] });
    await vanished.refresh.settle('s-1', { message: 'x', told: NOW });

    // Assert
    should(vanished.stored()).be.undefined();
  });
});
