import { describe, it } from 'bun:test';
import type { LaunchInstructionSectionId, SessionView } from '@ferretry/protocol';
import should from 'should';
import { withOutdated } from '../../../../src/lib/session/restart/outdated-view.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const view = (id: string, status: SessionView['state']['status'] = 'running'): SessionView =>
  sessionView(id, {}, { status });

const setup = (stale: Record<string, LaunchInstructionSectionId[]>, broken = new Set<string>()) => {
  const asked: string[] = [];
  let clock = 0;
  const reader = withOutdated(
    {
      list: async () => [view('a'), view('b'), view('c', 'stopped')],
      get: async id => (id === 'none' ? undefined : view(id)),
    },
    {
      outdated: async id => {
        asked.push(id);
        if (broken.has(id)) throw new Error('unreadable');
        return stale[id] ?? [];
      },
      now: () => clock,
      ttlMs: 5_000,
    },
  );
  return {
    reader,
    asked,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('withOutdated', () => {
  it('should mark only the outdated live ferrets, in the list and in a single read', async () => {
    const { reader, asked } = setup({ a: ['pack'], c: ['tools'] });
    const list = await reader.list();
    should(list.map(entry => entry.outdated)).eql([{ sections: ['pack'] }, undefined, undefined]);
    should(asked).eql(['a', 'b']);
    should((await reader.get('a'))?.outdated).eql({ sections: ['pack'] });
    should(await reader.get('none')).be.undefined();
  });

  it('should keep an answer for the ttl and ask again after it', async () => {
    const { reader, asked, advance } = setup({});
    await reader.get('a');
    advance(4_999);
    await reader.get('a');
    should(asked).eql(['a']);
    advance(2);
    await reader.get('a');
    should(asked).eql(['a', 'a']);
  });

  it('should treat a failure to work it out as not outdated', async () => {
    const { reader } = setup({}, new Set(['a']));
    should((await reader.get('a'))?.outdated).be.undefined();
  });
});
