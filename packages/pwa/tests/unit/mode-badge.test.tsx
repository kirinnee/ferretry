import { describe, expect, it } from 'bun:test';
import { Cpu, User } from 'lucide-react';
import { MODE_HINT, ModeBadge } from '../../src/shell/mode-badge.tsx';
import { render } from '../support/react.ts';

describe('ModeBadge', () => {
  it('accents the one mode you can talk to and leaves the common case neutral', () => {
    const interactive = render(<ModeBadge mode="interactive" />).root.findByType('span');
    expect(interactive.props['data-tone']).toBe('accent');
    expect(interactive.props.className).toBe('kt-badge shrink-0');

    const auto = render(<ModeBadge mode="auto" />).root.findByType('span');
    expect(auto.props['data-tone']).toBe('pend');
    expect(auto.props.className).toBe('kt-badge shrink-0 font-medium');
  });

  it('picks the glyph that matches who drives the session', () => {
    expect(render(<ModeBadge mode="interactive" />).root.findAllByType(User)).toHaveLength(1);
    expect(render(<ModeBadge mode="auto" />).root.findAllByType(Cpu)).toHaveLength(1);
  });

  it('spells out the supervision contract on hover for both modes', () => {
    expect(render(<ModeBadge mode="interactive" />).root.findByType('span').props.title).toBe(MODE_HINT.interactive);
    expect(render(<ModeBadge mode="auto" />).root.findByType('span').props.title).toBe(MODE_HINT.auto);
    expect(MODE_HINT.interactive).toContain('never auto-nudged');
    expect(MODE_HINT.auto).toContain('killed at 300s');
  });

  it('drops the word and keeps the icon in the dense size', () => {
    const dense = render(<ModeBadge mode="auto" size="sm" />).root.findByType('span');
    expect(dense.props.children).not.toContain('auto');

    const full = render(<ModeBadge mode="auto" size="md" />).root.findByType('span');
    expect(full.props.children).toContain('auto');
  });

  it('appends caller classes', () => {
    expect(render(<ModeBadge mode="auto" className="ml-1" />).root.findByType('span').props.className).toBe(
      'kt-badge shrink-0 font-medium ml-1',
    );
  });
});
