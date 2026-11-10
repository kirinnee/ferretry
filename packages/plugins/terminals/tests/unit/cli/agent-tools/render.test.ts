import { describe, expect, it } from 'bun:test';
import { renderControlView, renderToolReport } from '../../../../cli/lib/agent-tools/render.ts';
import type { SurfaceControlView } from '../../../../cli/lib/protocol/surface-control.ts';

const AT = '2026-11-07T10:00:00.000Z';
const emptyView = (): SurfaceControlView => ({
  sessionId: 'f-1',
  driving: [],
  takeovers: [],
  handed: [],
  opened: [],
  asked: [],
});

describe('a tool’s answer as lines', () => {
  it('says what happened, then each open terminal, then what was read', () => {
    const text = renderToolReport({
      summary: 'Two terminals.',
      surfaces: [
        { id: 't-1', name: 'dev', title: 'bun test' },
        { id: 't-2', title: 'shell', available: false },
        { id: 't-3', title: 'logs', available: true },
      ],
      output: 'hello',
    });
    expect(text.split('\n')).toEqual([
      'Two terminals.',
      '  dev  bun test',
      '  t-2  shell  [not yours]',
      '  t-3  logs',
      'hello',
    ]);
  });

  it('prints only the summary when nothing else came back, and skips an empty read', () => {
    expect(renderToolReport({ summary: 'Done.' })).toBe('Done.');
    expect(renderToolReport({ summary: 'Done.', output: '' })).toBe('Done.');
  });
});

describe('who is driving which terminal', () => {
  it('says nobody is driving or holding when there is nothing to show', () => {
    expect(renderControlView(emptyView())).toBe('no ferret is driving a terminal in f-1, and none is taken over');
  });

  it('names a driving ferret by its agent name or session, until when', () => {
    const view = {
      ...emptyView(),
      driving: [
        { surface: 'terminal', id: 't-1', name: 'dev', agentSessionId: 'a-1', agentName: 'Hadi', since: AT, until: AT },
        { surface: 'terminal', id: 't-2', agentSessionId: 'a-2', since: AT, until: AT },
        { surface: 'browser', id: 'b-1', agentSessionId: 'a-3', since: AT, until: AT },
      ],
    } as SurfaceControlView;
    expect(renderControlView(view).split('\n')).toEqual([
      `%terminal:dev  driven by Hadi until ${AT}`,
      `%terminal:t-2  driven by a-2 until ${AT}`,
    ]);
  });

  it('names who holds a terminal, a paired device or this computer', () => {
    const view = {
      ...emptyView(),
      takeovers: [
        { surface: 'terminal', id: 't-1', name: 'dev', by: { by: 'human', deviceId: 'phone' }, since: AT },
        { surface: 'terminal', id: 't-2', by: { by: 'local' }, since: AT },
        { surface: 'browser', id: 'b-1', by: { by: 'local' }, since: AT },
      ],
    } as SurfaceControlView;
    expect(renderControlView(view).split('\n')).toEqual([
      `%terminal:dev  taken over by device phone since ${AT}`,
      `%terminal:t-2  taken over by this computer since ${AT}`,
    ]);
  });

  it('names who handed a terminal to the ferret', () => {
    const view = {
      ...emptyView(),
      handed: [
        { surface: 'terminal', id: 't-1', name: 'dev', by: { by: 'human', deviceId: 'phone' }, at: AT },
        { surface: 'terminal', id: 't-2', by: { by: 'local' }, at: AT },
        { surface: 'browser', id: 'b-1', by: { by: 'local' }, at: AT },
      ],
    } as SurfaceControlView;
    expect(renderControlView(view).split('\n')).toEqual([
      '%terminal:dev  handed to the ferret by device phone',
      '%terminal:t-2  handed to the ferret by this computer',
    ]);
  });
});
