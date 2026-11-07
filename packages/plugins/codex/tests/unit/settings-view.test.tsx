/// <reference lib="dom" />
import { afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { ABSENT_VIEW } from '../../contract/testing/index.ts';
import type { HarnessCliView } from '../../contract/index.ts';

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
});
const current: HarnessCliView = {
  ...ABSENT_VIEW,
  location: { state: 'located', path: '/fixture/bin/codex', rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '0.140.0' },
  method: { kind: 'npm-global', tool: 'npm', package: '@openai/codex' },
  plan: {
    kind: 'self',
    steps: [{ command: 'npm install -g @openai/codex@latest' }],
    rollback: 'automatic',
    pinsVersion: true,
  },
  check: {
    state: 'ok',
    checkedAt: '2026-10-20T09:00:00.000Z' as never,
    latest: { version: '0.163.0', url: 'https://example.test' },
  },
  verification: 'older',
  available: true,
};
let updated: (() => void) | undefined;
function registered(call: (route: string, options?: unknown) => Promise<unknown>) {
  const half = app.build?.({
    manifest,
    client: {
      call,
      subscribe: (_event: unknown, listener: () => void) => {
        updated = listener;
        return () => {
          updated = undefined;
        };
      },
    },
  } as never);
  if (half === undefined) throw new Error('missing app half');
  return half.settings.codex as ComponentType;
}
async function mount(component: ComponentType) {
  const container = document.createElement('div');
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(component));
  });
  return container;
}
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
}

test('the registered Codex settings component renders, loads status and asks before an unverified Update', async () => {
  const calls: { route: string; options?: unknown }[] = [];
  const Component = registered(async (route, options) => {
    calls.push({ route, options });
    return route.startsWith('POST')
      ? { ...current, job: { state: 'running', command: 'npm update', startedAt: '2026-10-20T09:00:00.000Z' } }
      : current;
  });
  expect(renderToString(createElement(Component))).toContain('Reading which Codex');
  const panel = await mount(Component);
  expect(panel.textContent).toContain('Codex 0.140.0');
  expect(panel.textContent).toContain('/fixture/bin/codex');
  await click(panel, 'Update to 0.163.0');
  expect(panel.textContent).toContain('has not been verified by Ferretry yet');
  expect(calls.filter(call => call.route.startsWith('POST'))).toHaveLength(0);
  await click(panel, 'Cancel');
  expect(panel.querySelector('fieldset')).toBeNull();
  await click(panel, 'Update to 0.163.0');
  await click(panel, 'Update anyway');
  expect(calls.at(-1)).toEqual({
    route: 'POST /v1/codex/update',
    options: { body: { target: '0.163.0', confirmUnverified: true } },
  });
  expect(panel.textContent).toContain('Updating — running npm update');
  expect([...panel.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  await act(async () => {
    updated?.();
  });
  expect(calls.at(-1)?.route).toBe('GET /v1/codex/update');
  expect(panel.textContent).not.toContain('Updating — running npm update');
});

test('the registered view renders load failures and update refusals as messages', async () => {
  const failed = await mount(
    registered(async () => {
      throw new Error('offline');
    }),
  );
  expect(failed.querySelector('[role=alert]')?.textContent).toBe('offline');
  const panel = await mount(
    registered(async route => {
      if (route.startsWith('POST')) throw new Error('busy');
      return current;
    }),
  );
  await click(panel, 'Update to 0.145.0 (verified)');
  expect(panel.querySelector('[role=alert]')?.textContent).toBe('busy');
});
