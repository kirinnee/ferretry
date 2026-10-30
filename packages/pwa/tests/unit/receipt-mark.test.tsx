import { describe, expect, test } from 'bun:test';
import { ReceiptMark } from '../../src/components/receipt-mark.tsx';
import { MessageMarksLegend } from '../../src/features/settings/message-marks-legend.tsx';
import type { SendReceiptKind } from '../../src/lib/send-receipt.ts';
import { render } from '../support/react.ts';

const KINDS: readonly SendReceiptKind[] = [
  'sending',
  'held',
  'saved',
  'queued',
  'typed',
  'delivered',
  'answered',
  'read',
  'unconfirmed',
  'failed',
  'cancelled',
];

const draw = (kind: SendReceiptKind) =>
  render(<ReceiptMark className="fy-receipt-mark" kind={kind} />).root.findByType('svg');

describe('ReceiptMark', () => {
  test('every mark is a 14px-high, 1.75px, round-capped, colour-inheriting, decorative SVG', () => {
    for (const kind of KINDS) {
      const svg = draw(kind);
      expect(svg.props.height).toBe(14);
      expect(svg.props.strokeWidth).toBe(1.75);
      expect(svg.props.strokeLinecap).toBe('round');
      expect(svg.props.strokeLinejoin).toBe('round');
      expect(svg.props.stroke).toBe('currentColor');
      expect(svg.props['aria-hidden']).toBe('true');
      expect(svg.props['data-receipt-mark']).toBe(kind);
      // A hairline that scaled with the box would round differently at 1x, 2x and 3x.
      for (const path of svg.findAllByType('path')) expect(path.props.vectorEffect).toBe('non-scaling-stroke');
    }
  });

  test('saved is one clean check; each later mark is the SAME check again, offset by 35% of its width', () => {
    const single = draw('saved').findAllByType('path');
    const double = draw('queued').findAllByType('path');
    expect(single).toHaveLength(1);
    expect(double).toHaveLength(2);
    expect(double[0]?.props.d).toBe(single[0]?.props.d);
    // The check spans x 2..12, so its width is 10 and 35% of it is 3.5.
    expect(double[1]?.props.d).toBe('M5.5 8.5 9 12 15.5 4.5');
    expect(draw('delivered').findAllByType('path')).toHaveLength(3);
    expect(
      draw('answered')
        .findAllByType('path')
        .map(path => path.props.d),
    ).toEqual(
      draw('delivered')
        .findAllByType('path')
        .map(path => path.props.d),
    );
  });

  test('read is the same check four times, one more step to the right each, in a box that holds them', () => {
    const paths = draw('read')
      .findAllByType('path')
      .map(path => path.props.d);
    expect(paths).toEqual([
      'M2 8.5 5.5 12 12 4.5',
      'M5.5 8.5 9 12 15.5 4.5',
      'M9 8.5 12.5 12 19 4.5',
      'M12.5 8.5 16 12 22.5 4.5',
    ]);
    expect(draw('read').props.width).toBeGreaterThan(draw('delivered').props.width);
    expect(draw('delivered').props.width).toBeGreaterThan(draw('queued').props.width);
    expect(draw('read').props.height).toBe(14);
  });

  test('a clock, a question mark and a ! are each their own drawing, and sending and held share the clock', () => {
    const shapes = new Set(
      KINDS.map(kind =>
        draw(kind)
          .findAllByType('path')
          .map(path => path.props.d)
          .join('|'),
      ),
    );
    expect(shapes.size).toBe(KINDS.length - 2);
    expect(draw('failed').findAllByType('path')).toHaveLength(2);
  });

  test('the double tick is wider than the single so the box holds the offset, at the same height', () => {
    expect(draw('queued').props.width).toBeGreaterThan(draw('saved').props.width);
    expect(draw('queued').props.height).toBe(draw('saved').props.height);
  });
});

describe('MessageMarksLegend', () => {
  test('draws each legend row with the mark the transcript draws, its name and what it means', () => {
    const legend = render(<MessageMarksLegend />);
    const rows = legend.root.findAllByType('dt');
    expect(rows.map(row => row.findByType('svg').props['data-receipt-mark'])).toEqual([
      'sending',
      'saved',
      'queued',
      'typed',
      'delivered',
      'answered',
      'read',
      'unconfirmed',
      'failed',
      'cancelled',
    ]);
    expect(legend.root.findAllByType('dd')).toHaveLength(10);
    expect(JSON.stringify(legend.toJSON())).toContain('it is on the machine’s queue and waiting to be typed in.');
  });
});
