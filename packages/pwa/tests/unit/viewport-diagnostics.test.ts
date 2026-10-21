import { describe, expect, it } from 'bun:test';
import {
  bottomEdge,
  PILL_GAP,
  screenHeightNow,
  type ViewportReading,
  viewportFindings,
  viewportRows,
} from '../../src/lib/viewport-diagnostics.ts';

/** An iPhone 15 Pro running the installed app, everything where it belongs. */
const healthy: ViewportReading = {
  displayMode: 'standalone',
  iosStandalone: true,
  screen: { width: 393, height: 852 },
  innerWidth: 393,
  innerHeight: 852,
  clientHeight: 852,
  visual: { height: 852, offsetTop: 0 },
  units: { vh: 852, dvh: 852, svh: 852, lvh: 852 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
  safeBottom: 34,
  keyboardOpen: false,
  appHeight: null,
  shell: { top: 0, bottom: 852, height: 852 },
  bottomBar: { top: 678, bottom: 852, height: 174 },
  composer: { top: 686, bottom: 818, height: 132 },
  jumpPill: { top: 626, bottom: 670, height: 44 },
};

const tones = (reading: ViewportReading) => viewportFindings(reading).map(finding => finding.tone);
const texts = (reading: ViewportReading) => viewportFindings(reading).map(finding => finding.text);

describe('viewportRows', () => {
  it('lists every number a screenshot has to carry, in reading order', () => {
    const rows = viewportRows(healthy);
    expect(rows.map(row => row.label)).toEqual([
      'Display mode',
      'Screen',
      'innerWidth × innerHeight',
      'documentElement.clientHeight',
      'visualViewport',
      '100vh / dvh / svh / lvh',
      'Safe area top / right / bottom / left',
      '--safe-bottom',
      'Keyboard',
      '--app-h',
      'Shell',
      'Bottom bar',
      'Composer',
      'Jump to latest',
    ]);
    expect(rows.map(row => row.value)).toEqual([
      'standalone · iOS standalone yes',
      '393px × 852px',
      '393px × 852px',
      '852px',
      'height 852px · offsetTop 0px',
      '852px / 852px / 852px / 852px',
      '59px / 0px / 34px / 0px',
      '34px',
      'closed',
      'unset (the shell is 100dvh)',
      'top 0px · bottom 852px · height 852px',
      'top 678px · bottom 852px · height 174px',
      'top 686px · bottom 818px · height 132px',
      'top 626px · bottom 670px · height 44px',
    ]);
  });

  it('says what is absent rather than printing a zero, and rounds to a tenth of a pixel', () => {
    const rows = viewportRows({
      ...healthy,
      displayMode: 'browser',
      iosStandalone: null,
      visual: null,
      keyboardOpen: true,
      appHeight: '430px',
      safeBottom: 0.333,
      jumpPill: null,
    });
    const value = (label: string) => rows.find(row => row.label === label)?.value;
    expect(value('Display mode')).toBe('browser');
    expect(value('visualViewport')).toBe('not available');
    expect(value('Keyboard')).toBe('open');
    expect(value('--app-h')).toBe('430px');
    expect(value('--safe-bottom')).toBe('0.3px');
    expect(value('Jump to latest')).toBe('not on this screen');
    expect(viewportRows({ ...healthy, iosStandalone: false })[0]?.value).toBe('standalone · iOS standalone no');
  });
});

describe('the screen edge', () => {
  it('is the screen held the way the window is, because iOS keeps `screen` in portrait', () => {
    expect(screenHeightNow(healthy)).toBe(852);
    expect(screenHeightNow({ ...healthy, innerWidth: 852, innerHeight: 393 })).toBe(393);
  });

  it('is the screen for an installed app and the window for a browser tab', () => {
    expect(bottomEdge(healthy)).toBe(852);
    expect(bottomEdge({ ...healthy, displayMode: 'browser', iosStandalone: false, innerHeight: 659 })).toBe(659);
    // iOS's own flag counts even where the display-mode query does not answer.
    expect(bottomEdge({ ...healthy, displayMode: 'browser', iosStandalone: true, innerHeight: 793 })).toBe(852);
  });
});

describe('viewportFindings', () => {
  it('finds nothing wrong on a phone where everything is in place', () => {
    expect(tones(healthy)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(texts(healthy)).toEqual([
      'The installed app has the whole screen.',
      'The app reaches the bottom of the screen.',
      'The composer ends 34px above the bottom.',
      'Jump to latest sits 16px above the composer.',
    ]);
  });

  it('names the iOS 26 short viewport and the band it leaves under the app', () => {
    // WebKit bug 301108: the installed app's viewport is a status bar short, and the shell stops there.
    const short: ViewportReading = {
      ...healthy,
      innerHeight: 793,
      shell: { top: 0, bottom: 793, height: 793 },
      bottomBar: { top: 619, bottom: 793, height: 174 },
      composer: { top: 627, bottom: 759, height: 132 },
      jumpPill: { top: 567, bottom: 611, height: 44 },
    };
    expect(tones(short)).toEqual(['off', 'off', 'off', 'ok']);
    expect(texts(short).slice(0, 3)).toEqual([
      "The installed app's viewport is 59px shorter than the screen (the iOS 26 short-viewport bug).",
      'The app stops 59px above the bottom of the screen.',
      'The composer ends 93px above the bottom; at most 34px belongs there.',
    ]);
  });

  it('judges a browser tab against its window, and says nothing about installed screens there', () => {
    const tab: ViewportReading = {
      ...healthy,
      displayMode: 'browser',
      iosStandalone: false,
      innerHeight: 659,
      shell: { top: 0, bottom: 659, height: 659 },
      composer: { top: 500, bottom: 625, height: 125 },
      jumpPill: null,
    };
    expect(texts(tab)).toEqual([
      'The app reaches the bottom of the screen.',
      'The composer ends 34px above the bottom.',
    ]);
  });

  it('with the keyboard up, measures the composer against the visible box and skips the screen-edge checks', () => {
    const typing: ViewportReading = {
      ...healthy,
      keyboardOpen: true,
      safeBottom: 0,
      innerHeight: 852,
      shell: { top: 0, bottom: 430, height: 430 },
      composer: { top: 290, bottom: 422, height: 132 },
      jumpPill: null,
    };
    expect(texts(typing)).toEqual(['The composer ends 8px above the bottom.']);
    // Any more than the composer's own padding above the keys is dead space.
    expect(tones({ ...typing, composer: { top: 260, bottom: 392, height: 132 } })).toEqual(['off']);
  });

  it('holds the jump pill to its band above the composer, on either side', () => {
    const at = (gap: number) => ({ ...healthy, jumpPill: { top: 686 - gap - 44, bottom: 686 - gap, height: 44 } });
    expect(tones(at(PILL_GAP.min)).at(-1)).toBe('ok');
    expect(tones(at(PILL_GAP.max)).at(-1)).toBe('ok');
    expect(texts(at(4)).at(-1)).toBe('Jump to latest sits 4px above the composer; it belongs 8–16px above it.');
    expect(tones(at(60)).at(-1)).toBe('off');
  });

  it('reports only what is on this screen', () => {
    expect(
      viewportFindings({ ...healthy, displayMode: 'browser', iosStandalone: null, shell: null, composer: null }),
    ).toEqual([]);
    // No shell measured: the composer's distance to the floor cannot be judged, the pill's to the composer can.
    expect(texts({ ...healthy, displayMode: 'browser', iosStandalone: null, shell: null })).toEqual([
      'Jump to latest sits 16px above the composer.',
    ]);
  });
});
