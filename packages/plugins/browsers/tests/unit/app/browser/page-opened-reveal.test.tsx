import { describe, expect, test } from 'bun:test';
import { render } from '@ferretry/app/testing';
import manifest from '../../../../manifest.ts';
import { PageOpenedMark } from '../../../../app/features/browser/page-opened-mark.tsx';
import { browserViewerSlot } from '../../../../app/lib/scope.ts';

describe('a page the agent opens shows at once', () => {
  test('the row has its own mark, drawn through the ferrets list', () => {
    const panels = manifest.ui?.panels ?? [];
    expect(panels.some(panel => panel.slot === 'ferret.side' && panel.id === 'browser')).toBe(true);
    expect(panels.some(panel => panel.slot === 'ferrets.list-row-mark' && panel.id === 'page-opened')).toBe(true);
  });

  test('the row says nothing until a page opened where the owner was not looking', () => {
    expect(render(<PageOpenedMark daemon="d1" ferret="nobody" />).toJSON()).toBeNull();
  });
});

describe('the viewer slot', () => {
  test('tells a listener when the daemon names this screen, and when the stream ends; not when nothing changed', () => {
    const slot = browserViewerSlot();
    const heard: (string | undefined)[] = [];
    const stop = slot.subscribe(() => heard.push(slot.current()));
    slot.set('v1');
    slot.set('v1');
    slot.set(undefined);
    stop();
    slot.set('v2');
    expect(heard).toEqual(['v1', undefined]);
  });
});
