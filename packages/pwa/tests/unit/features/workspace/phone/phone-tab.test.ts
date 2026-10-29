import { describe, expect, it } from 'bun:test';
import {
  adjacentPhoneTab,
  centredScrollLeft,
  PHONE_CHAT_TAB,
  PHONE_CONSOLE_TAB,
  PHONE_PROCESSES_TAB,
  type PhoneTab,
  phoneTabOrder,
  phoneTabTakesKeys,
  TABLET_MIN_HEIGHT,
  workspaceFormFactor,
} from '../../../../../src/features/workspace/phone/phone-tab.ts';
import { DRAWER_MAX, RAIL_MAX } from '../../../../../src/hooks/use-layout-mode.ts';

const dev: PhoneTab = { id: 't1', kind: 'terminal', label: 'dev', driver: { name: 'hadi' } };
const app: PhoneTab = { id: 'b1', kind: 'browser', label: 'app' };

describe('phoneTabOrder', () => {
  it('leads with Chat, Console and Processes, then the workspace tabs in order', () => {
    expect(phoneTabOrder([dev, app]).map(tab => tab.id)).toEqual(['chat', 'console', 'processes', 't1', 'b1']);
  });

  it('drops a workspace tab that reuses a fixed id', () => {
    const clash: PhoneTab = { id: 'chat', kind: 'file', label: 'chat.md' };
    const console: PhoneTab = { id: 'console', kind: 'file', label: 'x' };
    const processes: PhoneTab = { id: 'processes', kind: 'file', label: 'y' };
    expect(phoneTabOrder([clash, console, processes, app])).toEqual([
      PHONE_CHAT_TAB,
      PHONE_CONSOLE_TAB,
      PHONE_PROCESSES_TAB,
      app,
    ]);
  });
});

describe('phoneTabTakesKeys', () => {
  it('gives terminal and console tabs the key bar, nothing else', () => {
    expect(phoneTabTakesKeys('terminal')).toBe(true);
    expect(phoneTabTakesKeys('console')).toBe(true);
    expect(phoneTabTakesKeys('chat')).toBe(false);
    expect(phoneTabTakesKeys('browser')).toBe(false);
    expect(phoneTabTakesKeys('file')).toBe(false);
  });
});

describe('adjacentPhoneTab', () => {
  const order = phoneTabOrder([dev, app]);
  it('steps either way without wrapping', () => {
    expect(adjacentPhoneTab(order, 'console', 'next')?.id).toBe('processes');
    expect(adjacentPhoneTab(order, 'processes', 'next')?.id).toBe('t1');
    expect(adjacentPhoneTab(order, 'console', 'previous')?.id).toBe('chat');
    expect(adjacentPhoneTab(order, 'chat', 'previous')).toBeNull();
    expect(adjacentPhoneTab(order, 'b1', 'next')).toBeNull();
  });

  it('answers null for a tab that is not in the row', () => {
    expect(adjacentPhoneTab(order, 'gone', 'next')).toBeNull();
  });
});

describe('centredScrollLeft', () => {
  it('centres a chip in the middle of a long row', () => {
    expect(centredScrollLeft({ scrollWidth: 1000, clientWidth: 300, chipLeft: 500, chipWidth: 80 })).toBe(390);
  });

  it('clamps at the start and at the end', () => {
    expect(centredScrollLeft({ scrollWidth: 1000, clientWidth: 300, chipLeft: 10, chipWidth: 80 })).toBe(0);
    expect(centredScrollLeft({ scrollWidth: 1000, clientWidth: 300, chipLeft: 950, chipWidth: 40 })).toBe(700);
  });

  it('never scrolls a row that fits', () => {
    expect(centredScrollLeft({ scrollWidth: 200, clientWidth: 300, chipLeft: 150, chipWidth: 40 })).toBe(0);
  });
});

describe('workspaceFormFactor', () => {
  it('is a phone below the drawer breakpoint in either orientation', () => {
    expect(workspaceFormFactor(390, 844)).toBe('phone');
    expect(workspaceFormFactor(DRAWER_MAX - 1, 1000)).toBe('phone');
  });

  it('keeps a landscape phone a phone', () => {
    expect(workspaceFormFactor(932, 430)).toBe('phone');
    expect(workspaceFormFactor(1000, TABLET_MIN_HEIGHT - 1)).toBe('phone');
  });

  it('splits a landscape tablet and keeps an upright one single', () => {
    expect(workspaceFormFactor(1024, 768)).toBe('tablet-split');
    expect(workspaceFormFactor(820, 1180)).toBe('phone');
  });

  it('is the desktop from the rail breakpoint up', () => {
    expect(workspaceFormFactor(RAIL_MAX, 500)).toBe('desktop');
    expect(workspaceFormFactor(1280, 800)).toBe('desktop');
  });
});
