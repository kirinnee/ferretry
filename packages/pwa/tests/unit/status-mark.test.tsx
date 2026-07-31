import { describe, expect, it } from 'bun:test';
import {
  nameToneClass,
  StatusMark,
  statusMark,
  TERMINAL_STATUSES,
  WAITING_STATUSES,
} from '../../src/shell/status-mark.tsx';
import { render } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

describe('statusMark', () => {
  it('gives every finished session a square that never breathes', () => {
    for (const status of TERMINAL_STATUSES) {
      const info = statusMark(sessionView('s', { state: { status } }));
      expect(info.shape).toBe('square');
      expect(info.klass).toBe('finished');
      expect(info.live).toBe(false);
      expect(info.label).toBe(`finished — ${status}`);
    }
  });

  it('separates a clean finish from every other ending by tone', () => {
    expect(statusMark(sessionView('s', { state: { status: 'completed' } })).tone).toBe('ok');
    for (const status of ['failed', 'stalled', 'stopped', 'kill_failed'] as const) {
      expect(statusMark(sessionView('s', { state: { status } })).tone).toBe('err');
    }
  });

  it('gives every waiting status a diamond', () => {
    for (const status of WAITING_STATUSES) {
      const info = statusMark(sessionView('s', { state: { status } }));
      expect(info.shape).toBe('diamond');
      expect(info.klass).toBe('waiting');
      expect(info.live).toBe(false);
      expect(info.label).toBe(`waiting — ${status}`);
    }
  });

  it('accents the two statuses that are asking a human for something', () => {
    expect(statusMark(sessionView('s', { state: { status: 'awaiting_user' } })).tone).toBe('accent');
    expect(statusMark(sessionView('s', { state: { status: 'awaiting_question' } })).tone).toBe('accent');
    expect(statusMark(sessionView('s', { state: { status: 'rate_limited' } })).tone).toBe('warn');
  });

  it('treats a declared wait as waiting even while the status still says running', () => {
    const info = statusMark(
      sessionView('s', {
        state: {
          status: 'running',
          waiting: { since: '1970-01-01T00:00:00.000Z', peerName: 'freddie', condition: 'CI to go green' },
        },
      }),
    );

    expect(info.shape).toBe('diamond');
    expect(info.label).toBe('waiting — parked for freddie: CI to go green');
  });

  it('names only the parts of a declared wait that exist', () => {
    const bare = statusMark(
      sessionView('s', { state: { status: 'running', waiting: { since: '1970-01-01T00:00:00.000Z' } } }),
    );
    expect(bare.label).toBe('waiting — parked');

    const peerOnly = statusMark(
      sessionView('s', {
        state: { status: 'running', waiting: { since: '1970-01-01T00:00:00.000Z', peerName: 'freddie' } },
      }),
    );
    expect(peerOnly.label).toBe('waiting — parked for freddie');

    const conditionOnly = statusMark(
      sessionView('s', {
        state: { status: 'running', waiting: { since: '1970-01-01T00:00:00.000Z', condition: 'the deploy' } },
      }),
    );
    expect(conditionOnly.label).toBe('waiting — parked: the deploy');
  });

  it('gives live work the only breathing circle', () => {
    const info = statusMark(sessionView('s', { state: { status: 'tool_running' } }));

    expect(info.shape).toBe('circle');
    expect(info.klass).toBe('active');
    expect(info.tone).toBe('warn');
    expect(info.live).toBe(true);
    expect(info.label).toBe('active — tool_running');
  });
});

describe('nameToneClass', () => {
  it('recedes a finished session and keeps live and waiting work at full strength', () => {
    expect(nameToneClass(sessionView('s', { state: { status: 'completed' } }))).toBe('text-muted');
    expect(nameToneClass(sessionView('s', { state: { status: 'running' } }))).toBe('text-fg');
    expect(nameToneClass(sessionView('s', { state: { status: 'awaiting_user' } }))).toBe('text-fg');
  });
});

describe('StatusMark', () => {
  it('announces the class and the raw status on one element, and hover-titles the same words', () => {
    const wrapper = render(
      <StatusMark view={sessionView('s', { state: { status: 'awaiting_user' } })} />,
    ).root.findByType('span');

    expect(wrapper.props.role).toBe('img');
    expect(wrapper.props['aria-label']).toBe('waiting — awaiting_user');
    expect(wrapper.props.title).toBe(wrapper.props['aria-label']);
  });

  it('keeps the outer box unrotated and 4px larger so a diamond does not move the row', () => {
    const spans = render(<StatusMark view={sessionView('s')} size={10} />).root.findAllByType('span');

    expect(spans[0]?.props.style).toEqual({ width: 14, height: 14 });
    expect(spans[1]?.props.style).toEqual({ width: 10, height: 10 });
    expect(spans[0]?.props.className).not.toContain('rotate-45');
  });

  it('draws the shape and the tone as classes, and hides the inner glyph from readers', () => {
    const glyph = render(<StatusMark view={sessionView('s', { state: { status: 'waiting' } })} />).root.findAllByType(
      'span',
    )[1];

    expect(glyph?.props['aria-hidden']).toBe(true);
    expect(glyph?.props.className).toBe('block border rotate-45 rounded-[1px] bg-warn border-warn-border');
  });

  it('breathes only for live work', () => {
    const live = render(<StatusMark view={sessionView('s', { state: { status: 'running' } })} />).root.findAllByType(
      'span',
    )[1];
    expect(live?.props.className).toContain('kt-pulse');

    const done = render(<StatusMark view={sessionView('s', { state: { status: 'completed' } })} />).root.findAllByType(
      'span',
    )[1];
    expect(done?.props.className).not.toContain('kt-pulse');
    expect(done?.props.className).toBe('block border rounded-[1px] bg-ok border-ok-border');
  });

  it('appends caller classes to the wrapper', () => {
    const wrapper = render(<StatusMark view={sessionView('s')} className="mr-2" />).root.findByType('span');
    expect(wrapper.props.className).toBe('inline-flex shrink-0 items-center justify-center mr-2');
  });
});
