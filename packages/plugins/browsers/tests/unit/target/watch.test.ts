import { describe, expect, test } from 'bun:test';
import { inputTargetConformance } from '@ferretry/core-vault/contract/testing';
import { PageInputTarget } from '../../../daemon/target/adapter.ts';
import { pageActLeavesSignIn, toolbarActLeavesSignIn } from '../../../daemon/target/sign-in/watch.ts';

describe('which acts leave who a page signs in', () => {
  test('I155 an agent act that may change who signs in clears the record: navigate, type, fill, raw mouse, a bare point', () => {
    for (const action of [
      { action: 'navigate' },
      { action: 'type' },
      { action: 'fill-form' },
      { action: 'mouse' },
      { action: 'drag' },
      { action: 'click' },
      { action: 'press', keys: ['a'] },
      { action: 'press', keys: ['Enter', 'x'] },
    ])
      expect(pageActLeavesSignIn(action)).toBe(false);
  });

  test('I155 a read, a hover, a scroll, Enter or Tab, or a click on a named element keeps it', () => {
    for (const action of [
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'hover' },
      { action: 'scroll' },
      { action: 'press', keys: ['Enter', 'Tab'] },
      { action: 'click', ref: 'e3' },
      { action: 'click', selector: '#account' },
    ])
      expect(pageActLeavesSignIn(action)).toBe(true);
  });

  test('I155 a toolbar act, whoever posted it, keeps it only for a read, a picture, the size, a start or a switch', () => {
    for (const action of ['read', 'screenshot', 'resize', 'start', 'activate-page'])
      expect(toolbarActLeavesSignIn({ action })).toBe(true);
    for (const action of ['navigate', 'back', 'reload', 'click', 'type'])
      expect(toolbarActLeavesSignIn({ action })).toBe(false);
  });
});

inputTargetConformance('the page input target', () => ({
  adapter: new PageInputTarget({
    inputOnPage: async () => {
      throw new Error('no such page in this session');
    },
  }),
  unknownKey: 'nowhere',
  kind: 'page',
}));
