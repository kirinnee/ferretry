import { describe, expect, test } from 'bun:test';
import { render } from '@ferretry/app/testing';
import manifest from '../../../../manifest.ts';
import { PageOpenedMark } from '../../../../app/features/browser/page-opened-mark.tsx';
import { PageChanged } from '../../../../contract/index.ts';

describe('a page the agent opens shows at once', () => {
  test('the Browser panel asks to be shown when a page opens, and the row has its own mark', () => {
    const panels = manifest.ui?.panels ?? [];
    const browser = panels.find(panel => panel.slot === 'ferret.side' && panel.id === 'browser');
    expect(browser?.reveal).toEqual({ on: PageChanged, when: 'opened' });
    expect(panels.some(panel => panel.slot === 'ferrets.list-row-mark' && panel.id === 'page-opened')).toBe(true);
  });

  test('the row says nothing until a page opened where the owner was not looking', () => {
    expect(render(<PageOpenedMark daemon="d1" ferret="nobody" />).toJSON()).toBeNull();
  });
});
