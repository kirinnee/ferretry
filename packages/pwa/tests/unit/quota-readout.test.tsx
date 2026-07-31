import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { type Quota, QuotaReadout, quotaResetsIn } from '../../src/shell/quota-readout.tsx';
import { render } from '../support/react.ts';

const NOW = 1_700_000_000_000;
const inMinutes = (minutes: number): number => NOW + minutes * 60_000;

const texts = (node: ReactTestInstance): string[] =>
  node
    .findAllByType('span')
    .flatMap(span => span.children.filter((child): child is string => typeof child === 'string'));

describe('quotaResetsIn', () => {
  it('has no answer when no reset was reported', () => {
    expect(quotaResetsIn(undefined, NOW)).toBeNull();
    expect(quotaResetsIn(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });

  it('says now for a window that has already rolled over', () => {
    expect(quotaResetsIn(NOW, NOW)).toBe('now');
    expect(quotaResetsIn(inMinutes(-5), NOW)).toBe('now');
  });

  it('counts minutes under the hour, and drops to whole hours past ten', () => {
    expect(quotaResetsIn(inMinutes(47), NOW)).toBe('47m');
    expect(quotaResetsIn(inMinutes(190), NOW)).toBe('3h 10m');
    expect(quotaResetsIn(inMinutes(180), NOW)).toBe('3h');
    expect(quotaResetsIn(inMinutes(11 * 60 + 10), NOW)).toBe('11h');
  });

  it('counts days once a window is more than a day out', () => {
    expect(quotaResetsIn(inMinutes(48 * 60), NOW)).toBe('2d');
  });
});

describe('QuotaReadout', () => {
  it('takes no space in a header when nothing is known, and says so where a column exists', () => {
    expect(render(<QuotaReadout quota={null} now={NOW} />).toJSON()).toBeNull();

    const unknown = render(<QuotaReadout quota={null} showUnknown now={NOW} />).root.findByType('span');
    expect(unknown.props.children).toBe('quota —');
    expect(unknown.props.className).toBe('mono shrink-0 text-faint');
    expect(unknown.props.title).toContain('no usage for this wrapper');
  });

  it('reports an auth failure as its own problem rather than as a quota', () => {
    const readout = render(
      <QuotaReadout quota={{ authOk: false, fiveHourPercent: 12 } as Quota} now={NOW} />,
    ).root.findByType('span');

    expect(readout.props.children).toBe('quota auth!');
    expect(readout.props.className).toContain('text-warn');
  });

  it('never renders a confident zero for a wrapper with no percentages', () => {
    expect(render(<QuotaReadout quota={{} as Quota} now={NOW} />).toJSON()).toBeNull();
    expect(
      render(<QuotaReadout quota={{} as Quota} showUnknown now={NOW} />).root.findByType('span').props.children,
    ).toBe('quota —');
  });

  it('still speaks up at limit even with no percentages at all', () => {
    const readout = render(<QuotaReadout quota={{ atLimit: true } as Quota} now={NOW} />).root;

    expect(texts(readout)).toContain('at limit');
    expect(readout.findByType('span').props.title).toContain('AT LIMIT');
  });

  it('shows both windows with a separator, and only the ones that exist', () => {
    const both = render(<QuotaReadout quota={{ fiveHourPercent: 30, weeklyPercent: 62 } as Quota} now={NOW} />).root;
    expect(texts(both)).toEqual(['5h ', '30', '%', '·', 'wk ', '62', '%']);

    const weekOnly = render(<QuotaReadout quota={{ weeklyPercent: 62 } as Quota} now={NOW} />).root;
    expect(texts(weekOnly)).toEqual(['wk ', '62', '%']);

    const fiveOnly = render(<QuotaReadout quota={{ fiveHourPercent: 30 } as Quota} now={NOW} />).root;
    expect(texts(fiveOnly)).toEqual(['5h ', '30', '%']);
  });

  it('stays colourless until a window is actually running out', () => {
    const calm = render(<QuotaReadout quota={{ fiveHourPercent: 30 } as Quota} now={NOW} />).root.findAllByType('span');
    expect(calm[1]?.props.className).toBe('');

    const warn = render(<QuotaReadout quota={{ fiveHourPercent: 75 } as Quota} now={NOW} />).root.findAllByType('span');
    expect(warn[1]?.props.className).toBe('text-warn');

    const err = render(<QuotaReadout quota={{ fiveHourPercent: 90 } as Quota} now={NOW} />).root.findAllByType('span');
    expect(err[1]?.props.className).toBe('text-err');
  });

  it('spells out each window and its rollover on hover', () => {
    const readout = render(
      <QuotaReadout
        quota={
          {
            fiveHourPercent: 30,
            weeklyPercent: 62,
            fiveHourResetAt: inMinutes(47),
            weeklyResetAt: inMinutes(48 * 60),
            atLimit: true,
          } as Quota
        }
        now={NOW}
      />,
    ).root.findByType('span');

    expect(readout.props.title).toBe(
      '5-hour window 30% used · resets in 47m\nweekly window 62% used · resets in 2d\nthis account is AT LIMIT — work is blocked until the window resets',
    );
  });

  it('omits the rollover clause when the daemon reported no reset time', () => {
    const readout = render(<QuotaReadout quota={{ fiveHourPercent: 30 } as Quota} now={NOW} />).root.findByType('span');

    expect(readout.props.title).toBe('5-hour window 30% used');
  });

  it('appends caller classes', () => {
    expect(
      render(<QuotaReadout quota={{ fiveHourPercent: 30 } as Quota} className="ml-2" now={NOW} />).root.findByType(
        'span',
      ).props.className,
    ).toBe('mono inline-flex shrink-0 items-center gap-1 ml-2');
    expect(
      render(<QuotaReadout quota={null} showUnknown className="ml-2" now={NOW} />).root.findByType('span').props
        .className,
    ).toBe('mono shrink-0 text-faint ml-2');
  });
});
