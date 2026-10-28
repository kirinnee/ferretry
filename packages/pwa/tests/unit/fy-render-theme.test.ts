import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import { readTheme } from '../../src/components/fy-render-theme.ts';
import '../support/dom.ts';

/**
 * The theme, read off the page. The unit DOM has no canvas, so the pixel a colour is resolved on is
 * handed in: a recorder that parses the few colour spellings these cases use, the way a browser's canvas
 * would, or `null` for a DOM without one. The real canvas is measured in `fy-render-component.visual.test.tsx`.
 */

/** A canvas that understands `#rrggbb` and `rgba(r, g, b, a)` and ignores anything else, as a real one does. */
const fakeCanvas = (): CanvasRenderingContext2D => {
  let style = '#000000';
  let painted = [0, 0, 0, 0];
  const parse = (value: string): number[] | null => {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
    if (hex !== null) return [...hex.slice(1, 4).map(part => Number.parseInt(part, 16)), 255];
    const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/u.exec(value);
    if (rgba !== null) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Math.round(Number(rgba[4]) * 255)];
    return null;
  };
  return {
    clearRect: () => {
      painted = [0, 0, 0, 0];
    },
    get fillStyle() {
      return style;
    },
    set fillStyle(value: string) {
      if (parse(value) !== null) style = value;
    },
    fillRect: () => {
      painted = parse(style) ?? painted;
    },
    getImageData: () => ({ data: Uint8ClampedArray.from(painted) }),
  } as unknown as CanvasRenderingContext2D;
};

const element = (tokens: Record<string, string>): HTMLElement => {
  const host = document.createElement('div');
  for (const [name, value] of Object.entries(tokens)) host.style.setProperty(`--${name}`, value);
  host.style.fontFamily = 'Inter, sans-serif';
  document.body.appendChild(host);
  return host;
};

const ambient = document.documentElement.getAttribute('data-theme');
afterEach(() => {
  document.body.innerHTML = '';
  if (ambient === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ambient);
});

describe('readTheme', () => {
  test('should resolve each token to a hex literal through the canvas, translucent ones with an alpha', () => {
    // Arrange
    document.documentElement.setAttribute('data-theme', 'studio-light');
    const host = element({
      accent: '#4F52D6',
      border: 'rgba(16, 32, 48, 0.5)',
      'radius-xs': '4px',
      'viz-1': 'nonsense',
    });

    // Act
    const theme = readTheme(host, fakeCanvas());

    // Assert — a colour the canvas will not take resolves to nothing, never to whatever it last held.
    should(theme.mode).equal('light');
    should(theme.colors.accent).equal('#4f52d6');
    should(theme.colors.border).equal('#10203080');
    should(theme.colors['viz-1']).equal('');
    should(theme.colors.muted).equal('');
    should(theme.radius).equal(4);
    should(theme.font).containEql('Inter');
  });

  test('should pass a hex token through and drop any other where there is no canvas', () => {
    // Arrange
    document.documentElement.setAttribute('data-theme', 'mission-dark');
    const host = element({ accent: '#47F3FF', border: 'rgba(1, 2, 3, 0.5)', 'radius-xs': '-3px' });

    // Act
    const theme = readTheme(host, null);

    // Assert
    should(theme.mode).equal('dark');
    should(theme.colors.accent).equal('#47f3ff');
    should(theme.colors.border).equal('');
    should(theme.radius).equal(0);
  });

  test('should read the document root, with the shared pixel, when no element is given', () => {
    // Act — this DOM has no canvas, so the shared pixel is `null` and nothing throws.
    const theme = readTheme(null);

    // Assert
    should(Object.values(theme.colors).every(value => value === '' || value.startsWith('#'))).be.true();
  });

  test('should answer an unread theme for an element the style system cannot read', () => {
    // Act
    const theme = readTheme({} as Element, null);

    // Assert
    should(theme.font).equal('');
    should(Object.values(theme.colors).every(value => value === '')).be.true();
  });
});
