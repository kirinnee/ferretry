import { describe, it } from 'bun:test';
import type { SessionLaunchInstructions } from '@ferretry/protocol';
import should from 'should';
import { outdatedSections } from '../../../../src/lib/session/launch/outdated.ts';

type Section = SessionLaunchInstructions['sections'][number];

const record = (sections: SessionLaunchInstructions['sections']): SessionLaunchInstructions => ({
  sections,
  mode: 'auto',
  questions: false,
});

const TOOLS: Section = { id: 'tools', chars: 10, digest: 'a' };
const SETTINGS: Section = { id: 'settings', chars: 20, digest: 'b' };
const NOTIFY: Section = { id: 'notify', chars: 30, digest: 'c' };
const base = [TOOLS, SETTINGS, NOTIFY];

describe('outdatedSections', () => {
  it('should find nothing for a session with no record', () => {
    should(outdatedSections(undefined, record(base))).deepEqual([]);
  });

  it('should find nothing when every section matches', () => {
    should(outdatedSections(record(base), record(base))).deepEqual([]);
  });

  it('should name a section whose words changed, by fingerprint', () => {
    const now = record([TOOLS, { id: 'settings', chars: 20, digest: 'z' }, NOTIFY]);
    should(outdatedSections(record(base), now)).deepEqual(['settings']);
  });

  it('should not call a section changed when only the size is compared and it matches', () => {
    const old = record([{ id: 'tools', chars: 10 }, SETTINGS, NOTIFY]);
    should(outdatedSections(old, record(base))).deepEqual([]);
    const grown = record([{ id: 'tools', chars: 11, digest: 'q' }, SETTINGS, NOTIFY]);
    should(outdatedSections(old, grown)).deepEqual(['tools']);
  });

  it('should compare sizes when the current section has no fingerprint', () => {
    const now = record([{ id: 'tools', chars: 10 }, SETTINGS, NOTIFY]);
    should(outdatedSections(record(base), now)).deepEqual([]);
  });

  it('should name a section switched on since the launch, and one switched off', () => {
    const on = record([...base, { id: 'agenda', chars: 5, digest: 'd' }]);
    should(outdatedSections(record(base), on)).deepEqual(['agenda']);
    should(outdatedSections(on, record(base))).deepEqual(['agenda']);
  });

  it('should read an old agenda section as notify, so the rename alone is not a change', () => {
    const old = record([TOOLS, SETTINGS, { id: 'attention', chars: 30, digest: 'c' }]);
    should(outdatedSections(old, record(base))).deepEqual([]);
    const changed = record([TOOLS, SETTINGS, { id: 'attention', chars: 99 }]);
    should(outdatedSections(changed, record(base))).deepEqual(['notify']);
  });

  it('should list differing sections in prompt order', () => {
    const now = record([
      { id: 'tools', chars: 1, digest: 'x' },
      SETTINGS,
      NOTIFY,
      { id: 'learning', chars: 4, digest: 'l' },
      { id: 'hypermedia', chars: 4, digest: 'h' },
    ]);
    should(outdatedSections(record(base), now)).deepEqual(['tools', 'hypermedia', 'learning']);
  });
});
