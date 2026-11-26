import { expect, test } from 'bun:test';
import type { HarnessScreenReader, RunSpec } from '@ferretry/core-ferrets/contract';
import {
  harnessController,
  readHarnessPane,
  harnessTurnLook,
  launchChainOf,
} from '../../../../daemon/lib/tmux/harness-screen.ts';
import {
  composerState,
  frameCursor,
  draftBlockingReadiness,
  nextReadinessStep,
  startupSettleStep,
  classifySubmit,
} from '../../../../daemon/lib/tmux/delivery.ts';
import { readComposer } from '../../../../daemon/lib/tmux/composer-screen.ts';
import { turnLookOf } from '../../../../daemon/lib/tmux/turn-look.ts';
import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';

const pane = {
  alive: true,
  dead: false,
  promptReady: true,
  visible: '› Legacy-looking text',
  history: '',
  cursorX: 2,
  cursorY: 0,
};
const port: TmuxCommandPort = {
  execute: async args => ({
    code: 0,
    stderr: '',
    stdout: args[0] === 'display-message' ? '0||2|0|24|100' : pane.visible,
  }),
};

test('only the registered key selects a plugin screen reader', async () => {
  let reads = 0;
  const reader: HarnessScreenReader = {
    key: 'opencode',
    read: () => {
      reads++;
      return { working: false, atPrompt: true, composer: { text: '', placeholder: false, pasted: false } };
    },
  };
  for (const key of ['fake-third', 'claude', 'claude-code', 'codex', undefined]) {
    const frame = await harnessController(port, { key, screenReader: reader }).state('fy-test');
    expect(frame.promptReady).toBe(false);
    expect(composerState(frame)).toEqual({ kind: 'unreadable' });
  }
  expect(reads).toBe(0);
  const frame = await harnessController(port, { key: 'opencode', screenReader: reader }).state('fy-test');
  expect(frame.promptReady).toBe(true);
  expect(composerState(frame)).toEqual({ kind: 'empty' });
  expect(reads).toBe(1);
});

test('the plugin composer reading is used for draft and landing evidence; unknown never falls back to legacy text', () => {
  const reading = {
    working: false,
    atPrompt: true,
    composer: { text: 'draft only', placeholder: false, pasted: false },
  };
  const frame = { ...pane, screen: reading };
  expect(composerState(frame)).toEqual({ kind: 'input', text: 'draft only' });
  expect(readComposer(frame.visible, frameCursor(frame))?.text).toBe('draft only');
  const unknown = { ...pane, promptReady: false, screen: { working: true, atPrompt: false, composer: null } };
  expect(composerState(unknown)).toEqual({ kind: 'unreadable' });
  const looked = turnLookOf(unknown, () => 'digest');
  expect(looked.working).toBe(true);
  expect(looked.atPrompt).toBe(false);
  expect(readHarnessPane(pane, undefined)).toEqual(pane);
  const legacy = { ...frame, visible: 'Waiting for startup', promptReady: false };
  expect(draftBlockingReadiness(legacy)).toBe('draft only');
  expect(startupSettleStep(legacy)).toEqual({ kind: 'settled' });
  expect(nextReadinessStep(unknown, new Map())).toEqual({ kind: 'wait' });
  expect(classifySubmit(legacy, 'draft only', 'chars')).toEqual({ kind: 'holding' });
  expect(classifySubmit({ ...legacy, screen: { ...reading, composer: null } }, 'unreadable', 'chars')).toEqual({
    kind: 'delivered',
    outcome: 'turn-started',
  });
});

test('launch identity carries the reader, and a failing reader becomes unreadable', async () => {
  const reader: HarnessScreenReader = {
    key: 'opencode',
    read: () => {
      throw new Error('unreadable');
    },
  };
  expect(launchChainOf({} as RunSpec)).toBeUndefined();
  const launch = launchChainOf({
    execChain: ['env', 'opencode'],
    harness: 'opencode',
    screenReader: reader,
  } as unknown as RunSpec);
  expect(launch?.screenReader).toBe(reader);
  expect(launch?.through.has('env')).toBe(true);
  expect(harnessTurnLook(pane, () => 'digest', launch).atPrompt).toBe(false);
  expect((await harnessController(port, launch).state('fy-test')).promptReady).toBe(false);
});
