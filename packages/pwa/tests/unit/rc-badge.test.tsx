import { describe, expect, it } from 'bun:test';
import { RcBadge } from '../../src/shell/rc-badge.tsx';
import { render } from '../support/react.ts';

describe('RcBadge', () => {
  it('renders nothing when the session was never launched with RC', () => {
    expect(render(<RcBadge />).toJSON()).toBeNull();
    expect(render(<RcBadge remoteControl={false} />).toJSON()).toBeNull();
  });

  it('becomes a real link once the harness has announced its RC surface', () => {
    const link = render(<RcBadge remoteControl url="https://rc.example.test/s/1" />).root.findByType('a');

    expect(link.props.href).toBe('https://rc.example.test/s/1');
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noreferrer');
    expect(link.props['data-tone']).toBe('ok');
    expect(link.props.title).toContain('https://rc.example.test/s/1');
  });

  it('links even when the launch flag was never recorded, because the URL is the proof', () => {
    expect(render(<RcBadge url="https://rc.example.test/s/1" />).root.findAllByType('a')).toHaveLength(1);
  });

  it('stops the click so opening RC never also navigates the row underneath', () => {
    let stopped = 0;
    const link = render(<RcBadge remoteControl url="https://rc.example.test/s/1" />).root.findByType('a');

    link.props.onClick({
      stopPropagation: () => {
        stopped += 1;
      },
    });

    expect(stopped).toBe(1);
  });

  it('still shows a badge while the surface has not announced itself, so absence never reads as off', () => {
    const badge = render(<RcBadge remoteControl />).root.findByType('span');

    expect(badge.props['data-tone']).toBe('pend');
    expect(badge.props.title).toContain('waiting for the harness');
  });

  it('drops the label in the dense size, for both states', () => {
    expect(render(<RcBadge remoteControl size="sm" />).root.findByType('span').props.children).not.toContain('rc');
    expect(render(<RcBadge remoteControl size="md" />).root.findByType('span').props.children).toContain('rc');
    expect(
      render(<RcBadge url="https://rc.example.test/s/1" size="sm" />).root.findByType('a').props.children,
    ).not.toContain('rc');
  });

  it('appends caller classes in both states', () => {
    expect(render(<RcBadge remoteControl className="ml-1" />).root.findByType('span').props.className).toBe(
      'kt-badge shrink-0 ml-1',
    );
    expect(
      render(<RcBadge url="https://rc.example.test/s/1" className="ml-1" />).root.findByType('a').props.className,
    ).toContain('ml-1');
  });
});
