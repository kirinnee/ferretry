import { afterEach, describe, expect, test } from 'bun:test';
import { hasWords, joinMeta } from '../../../../app/features/agenda/card-meta-line.tsx';
import { type Mounted, mount } from '@ferretry/app/testing';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const draw = async (parts: ReadonlyArray<string | null | undefined | false>) => {
  view = await mount(
    <div>
      {joinMeta(...parts.map(part => (hasWords(part || null) ? <span key={String(part)}>{part}</span> : part)))}
    </div>,
  );
  const dots = view.container.querySelectorAll('.fy-meta-line__dot').length;
  const words = [...view.container.querySelectorAll('span:not(.fy-meta-line__dot)')].map(each => each.textContent);
  return { dots, words, text: view.container.textContent };
};

describe('joinMeta puts a dot only between parts that draw something', () => {
  test('joins every present part with one dot between each pair', async () => {
    expect(await draw(['ferretry', 'Judson', 'studio'])).toMatchObject({ dots: 2, text: 'ferretry·Judson·studio' });
  });

  test('draws no leading dot when the first part is empty', async () => {
    expect(await draw([null, 'ferretry', 'Judson'])).toMatchObject({ dots: 1, text: 'ferretry·Judson' });
  });

  test('draws no doubled dot when a middle part is empty', async () => {
    expect(await draw(['ferretry', undefined, 'Judson'])).toMatchObject({ dots: 1, text: 'ferretry·Judson' });
    expect(await draw(['ferretry', '   ', 'Judson'])).toMatchObject({ dots: 1 });
  });

  test('draws no trailing dot when the last part is empty', async () => {
    expect(await draw(['ferretry', 'Judson', false])).toMatchObject({ dots: 1, text: 'ferretry·Judson' });
  });

  test('draws no dot at all for one part, or for none', async () => {
    expect(await draw([null, 'Judson', null])).toMatchObject({ dots: 0, text: 'Judson' });
    expect(await draw([null, undefined, false])).toMatchObject({ dots: 0, text: '' });
  });
});

describe('hasWords', () => {
  test('is true only for text that says something', () => {
    expect(hasWords('ferretry')).toBe(true);
    expect(hasWords('')).toBe(false);
    expect(hasWords('  ')).toBe(false);
    expect(hasWords(null)).toBe(false);
    expect(hasWords(undefined)).toBe(false);
  });
});
