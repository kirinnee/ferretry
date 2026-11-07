import { describe, expect, it } from 'bun:test';
import type { LimitsView } from '@ferretry/protocol';
import { cgroupConfigView } from '../../../../../protocol/tests/fixtures.ts';
import { InfoAbout } from '../../../../src/features/session-info/info-about.tsx';
import { memoryNote } from '../../../../src/features/session-info/memory-note.ts';
import { render } from '../../../support/react.ts';

const view = (over: Partial<LimitsView>): LimitsView => ({ ...cgroupConfigView, ...over });

describe('memoryNote', () => {
  it('says nothing for a ferret the machine did nothing to', () => {
    expect(memoryNote(view({ throttled: [{ sessionId: 'other' }] }), 'mine')).toBeNull();
  });

  it('says a ferret is slowed, in plain words', () => {
    const note = memoryNote(view({ throttled: [{ sessionId: 'mine', callsign: 'gertrude' }] }), 'mine');
    expect(note?.kind).toBe('slowed');
    expect(note?.text).toContain('Slowed for memory');
    expect(note?.text).not.toContain('cgroup');
  });

  it('says something was killed for memory, naming it, and prefers that over being slowed', () => {
    const note = memoryNote(
      view({
        throttled: [{ sessionId: 'mine' }],
        killed: [{ sessionId: 'mine', at: '2026-11-05T23:04:00Z', what: 'bun test' }],
      }),
      'mine',
    );
    expect(note?.kind).toBe('killed');
    expect(note?.text).toContain('killed for memory (bun test)');
  });

  it('says, on a machine that only watches, that nothing is capped', () => {
    const note = memoryNote(view({ overBudget: [{ sessionId: 'mine', bytes: 13_000_000_000 }] }), 'mine');
    expect(note?.text).toContain('does not cap it');
  });
});

describe('InfoAbout › Memory', () => {
  const session = { config: { id: 'mine', agent: 'claude' }, state: { id: 'mine', status: 'running' } } as never;

  it('shows the memory row only when the machine did something to this ferret', () => {
    const quiet = render(<InfoAbout subFerrets={[]} view={session} />);
    const slowed = render(
      <InfoAbout subFerrets={[]} view={session} memory={{ kind: 'slowed', text: 'Slowed for memory right now.' }} />,
    );
    expect(JSON.stringify(quiet.toJSON())).not.toContain('Memory');
    expect(JSON.stringify(slowed.toJSON())).toContain('Memory');
    expect(JSON.stringify(slowed.toJSON())).toContain('Slowed for memory right now.');
  });
});
