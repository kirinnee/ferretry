import { describe, expect, test } from 'bun:test';
import type { InstructionEntry } from '@ferretry/kernel/contract';
import { FerretLaunchSectionsFiles } from '../../../../contract/index.ts';
import {
  applicableInstructions,
  outdatedSectionIds,
  sectionDigests,
} from '../../../../daemon/lib/ferrets/launch-sections.ts';
import { instructionDigest } from '../../../../daemon/lib/session/peers/fleet.ts';
import { archiveWorld, startFerret } from '../../../support/daemon/archive-world.ts';

/** What a launch told a ferret, and whether the words a launch would give now differ (U6, `restart --outdated`). */

const entry = (id: string, text: string, when: InstructionEntry['when'] = { role: 'any' }): InstructionEntry => ({
  plugin: 'board' as never,
  id,
  text,
  when,
});

describe('which entries a launch gives a ferret', () => {
  const entries = [
    entry('board', 'the board rules'),
    entry('lead-only', 'for leads', { role: 'lead' }),
    entry('helper-only', 'for helpers', { role: 'helper' }),
    entry('claude-only', 'for claude', { harness: 'claude-code' }),
    entry('codex-only', 'for codex', { harness: 'codex' }),
    entry('everyone', 'for all', {}),
  ];

  test('role and harness narrow, and an entry that names neither is for everyone', () => {
    const ids = (role: 'lead' | 'helper', harness: string) =>
      applicableInstructions(entries, { role, harness: harness as never }).map(each => each.id);
    expect(ids('lead', 'claude-code')).toEqual(['board', 'lead-only', 'claude-only', 'everyone']);
    expect(ids('helper', 'codex')).toEqual(['board', 'helper-only', 'codex-only', 'everyone']);
  });
});

describe('what a launch records and what differs', () => {
  const told = sectionDigests([entry('board', 'the board rules'), entry('notify', 'say it once')]);

  test('each section is recorded by id and fingerprint, never by its words', () => {
    expect(told).toEqual({ board: instructionDigest('the board rules'), notify: instructionDigest('say it once') });
    expect(JSON.stringify(told)).not.toContain('the board rules');
  });

  test('the same words are current; a reworded, added or dropped section is outdated, in the order the ids are listed', () => {
    expect(outdatedSectionIds(told, told)).toEqual([]);
    expect(
      outdatedSectionIds(told, sectionDigests([entry('board', 'REWORDED'), entry('notify', 'say it once')])),
    ).toEqual(['board']);
    expect(outdatedSectionIds(told, sectionDigests([entry('board', 'the board rules')]))).toEqual(['notify']);
    expect(
      outdatedSectionIds(
        told,
        sectionDigests([entry('board', 'the board rules'), entry('notify', 'say it once'), entry('asks', 'new')]),
      ),
    ).toEqual(['asks']);
    expect(outdatedSectionIds(told, {})).toEqual(['notify', 'board']);
  });

  test('a ferret that recorded nothing is never outdated, and an id this build does not list is left out, not guessed', () => {
    expect(outdatedSectionIds(undefined, sectionDigests([entry('board', 'x')]))).toEqual([]);
    expect(outdatedSectionIds({ 'a-future-section': 'abc' }, {})).toEqual([]);
  });
});

describe('a launch records what it told the ferret', () => {
  test('starting a ferret writes launch-sections.json beside its record, as { format: 1, sections }', async () => {
    const { h } = await archiveWorld();
    const id = await startFerret(h, 'aniya');
    const stored = JSON.parse(h.state('ferrets').raw(FerretLaunchSectionsFiles, id) as string) as {
      format: number;
      sections: Record<string, string>;
    };
    expect(stored.format).toBe(1);
    // The test host's snapshot declares no instruction entries: the launch told nothing, and says so.
    expect(stored.sections).toEqual({});
    await h.stop();
  });
});
