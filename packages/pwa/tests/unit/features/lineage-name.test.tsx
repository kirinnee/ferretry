import { describe, expect, it } from 'bun:test';

import { LineageName } from '../../../src/features/lineage/lineage-name.tsx';
import { lineageLabel } from '../../../src/lib/lineage.ts';
import { render } from '../../support/react.ts';
import { sessionView } from '../../support/sessions.ts';

describe('LineageName', () => {
  it('keeps the callsign visible while a long task remains the shrinkable segment', () => {
    const label = lineageLabel(
      sessionView('abcdefghijk', { config: { teammate: 'molly', name: 'Ship the lineage surface' } }),
    );
    const rendered = render(<LineageName label={label} className="test-name" />).root.findByType('span');

    expect(rendered.props.title).toBe('Molly · Ship the lineage surface · abcdefghijk');
    const spans = rendered.findAllByType('span');
    expect(spans.some(span => span.children.includes('Molly'))).toBeTrue();
    expect(spans.some(span => span.children.includes('Ship the lineage surface'))).toBeTrue();
    expect(spans.some(span => span.props.className === 'sr-only')).toBeTrue();
  });

  it('falls back to the short session id when daemon data contains no callsign or task', () => {
    const label = lineageLabel(sessionView('abcdefghijk', { config: { teammate: undefined, name: '' } }));
    const rendered = render(<LineageName label={label} />);

    expect(JSON.stringify(rendered.toJSON())).toContain('abcdefgh…');
  });
});
