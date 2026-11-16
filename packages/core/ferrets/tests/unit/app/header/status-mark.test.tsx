import { describe, expect, it } from 'bun:test';
import { nameToneClass, StatusMark, statusMark } from '../../../../app/lib/status-mark.tsx';
import { render } from '../support/react.ts';

const WAIT_SINCE = '1970-01-01T00:00:00.000Z' as never;

describe('statusMark', () => {
  it('gives a stopped ferret a square that never breathes', () => {
    const info = statusMark({ state: 'stopped' });
    expect(info.shape).toBe('square');
    expect(info.klass).toBe('finished');
    expect(info.live).toBe(false);
    expect(info.label).toBe('finished — stopped');
  });

  it('separates a clean finish from every other ending by tone', () => {
    expect(statusMark({ state: 'stopped', finishedAt: WAIT_SINCE }).tone).toBe('ok');
    expect(statusMark({ state: 'stopped', finishedAt: WAIT_SINCE }).label).toBe('finished — done');
    expect(statusMark({ state: 'stopped' }).tone).toBe('err');
  });

  it('gives a ferret at its prompt a calm diamond', () => {
    const info = statusMark({ state: 'idle' });
    expect(info).toMatchObject({ shape: 'diamond', klass: 'waiting', tone: 'ok', live: false });
    expect(info.label).toBe('waiting — your turn');
  });

  it('treats a declared wait as waiting even while the state still says working', () => {
    const info = statusMark({
      state: 'working',
      waiting: { since: WAIT_SINCE, peerName: 'freddie', condition: 'CI to go green' },
    });

    expect(info.shape).toBe('diamond');
    expect(info.label).toBe('waiting — parked for freddie: CI to go green');
  });

  it('names only the parts of a declared wait that exist', () => {
    expect(statusMark({ state: 'working', waiting: { since: WAIT_SINCE } }).label).toBe('waiting — parked');
    expect(statusMark({ state: 'working', waiting: { since: WAIT_SINCE, peerName: 'freddie' } }).label).toBe(
      'waiting — parked for freddie',
    );
    expect(statusMark({ state: 'working', waiting: { since: WAIT_SINCE, condition: 'the deploy' } }).label).toBe(
      'waiting — parked: the deploy',
    );
  });

  it('gives live work the only breathing circle', () => {
    for (const state of ['starting', 'working'] as const) {
      const info = statusMark({ state });
      expect(info).toMatchObject({ shape: 'circle', klass: 'active', tone: 'warn', live: true });
      expect(info.label).toBe(`active — ${state}`);
    }
  });

  it('never lets a declared park outlive the ferret being over', () => {
    expect(statusMark({ state: 'stopped', waiting: { since: WAIT_SINCE } }).klass).toBe('finished');
  });
});

describe('nameToneClass', () => {
  it('recedes a stopped ferret and keeps live and waiting work at full strength', () => {
    expect(nameToneClass({ state: 'stopped' })).toBe('text-muted');
    expect(nameToneClass({ state: 'working' })).toBe('text-fg');
    expect(nameToneClass({ state: 'idle' })).toBe('text-fg');
  });
});

describe('StatusMark', () => {
  it('announces the class and the state in words on one element, and hover-titles the same words', () => {
    const wrapper = render(<StatusMark ferret={{ state: 'idle' }} />).root.findByType('span');

    expect(wrapper.props.role).toBe('img');
    expect(wrapper.props['aria-label']).toBe('waiting — your turn');
    expect(wrapper.props.title).toBe(wrapper.props['aria-label']);
  });

  it('keeps the outer box unrotated and 4px larger so a diamond does not move the row', () => {
    const spans = render(<StatusMark ferret={{ state: 'idle' }} size={10} />).root.findAllByType('span');

    expect(spans[0]?.props.style).toEqual({ width: 14, height: 14 });
    expect(spans[1]?.props.style).toEqual({ width: 10, height: 10 });
    expect(spans[0]?.props.className).not.toContain('rotate-45');
  });

  it('draws the shape and the tone as classes, and hides the inner glyph from readers', () => {
    const glyph = render(
      <StatusMark ferret={{ state: 'working', waiting: { since: WAIT_SINCE } }} />,
    ).root.findAllByType('span')[1];

    expect(glyph?.props['aria-hidden']).toBe(true);
    expect(glyph?.props.className).toBe('block border rotate-45 rounded-[1px] bg-warn border-warn-border');
  });

  it('breathes only for live work', () => {
    const live = render(<StatusMark ferret={{ state: 'working' }} />).root.findAllByType('span')[1];
    expect(live?.props.className).toContain('kt-pulse');

    const done = render(<StatusMark ferret={{ state: 'stopped', finishedAt: WAIT_SINCE }} />).root.findAllByType(
      'span',
    )[1];
    expect(done?.props.className).not.toContain('kt-pulse');
    expect(done?.props.className).toBe('block border rounded-[1px] bg-ok border-ok-border');
  });

  it('appends caller classes to the wrapper', () => {
    const wrapper = render(<StatusMark className="mr-2" ferret={{ state: 'idle' }} />).root.findByType('span');
    expect(wrapper.props.className).toBe('inline-flex shrink-0 items-center justify-center mr-2');
  });
});
