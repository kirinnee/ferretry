import { expect, it } from 'bun:test';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { BrowserCapture } from '../../../daemon/worker/capture/index.ts';

type Tab = 'first' | 'survivor';
type State = 'active' | 'frozen';
const INSPECTION_FAILURE = 'fixture stopped before taking pixels';

function twoTabs(
  onLifecycle: (tab: Tab, state: State) => void | Promise<void>,
  deadline: <T>(work: Promise<T>) => Promise<T> = work => work,
) {
  const commands: [Tab, State][] = [];
  const lifecycle = new Map<Tab, State>();
  const sessions = new Map<Page, CDPSession>();
  const context = { pages: () => [...sessions.keys()], on: () => undefined } as unknown as BrowserContext;

  const addTab = (name: Tab) => {
    const page = {
      context: () => context,
      frames: () => [],
      isClosed: () => false,
      on: () => undefined,
    } as unknown as Page;
    lifecycle.set(name, 'active');
    const session = {
      async send(method: string, { state }: { state: State }) {
        if (method === 'DOMSnapshot.captureSnapshot') throw new Error(INSPECTION_FAILURE);
        expect(method).toBe('Page.setWebLifecycleState');
        commands.push([name, state]);
        await onLifecycle(name, state);
        lifecycle.set(name, state);
        return {};
      },
    } as unknown as CDPSession;
    sessions.set(page, session);
    return page;
  };
  addTab('first');
  const survivor = addTab('survivor');
  const capture = new BrowserCapture(
    async page => {
      const session = sessions.get(page);
      if (!session) throw new Error('fixture tab has no session');
      return session;
    },
    async () => {
      throw new Error('the fixture should prevent composition');
    },
    deadline,
  );
  return {
    commands,
    lifecycle,
    capture: () =>
      capture.fieldShot(survivor, async () => {
        throw new Error('the fixture should prevent taking pixels');
      }),
  };
}

it('capture cleanup restores the surviving tab when an earlier lifecycle session rejects', async () => {
  const tabs = twoTabs((tab, state) => {
    if (tab === 'first' && state === 'active') throw new Error('the first lifecycle session closed while restoring');
  });

  await expect(tabs.capture()).rejects.toThrow(INSPECTION_FAILURE);
  expect(tabs.commands).toEqual([
    ['first', 'frozen'],
    ['survivor', 'frozen'],
    ['first', 'active'],
    ['survivor', 'active'],
  ]);
  expect(tabs.lifecycle.get('survivor')).toBe('active');
});

it('capture cleanup restores a late freeze acknowledgement without freezing the next tab after the deadline', async () => {
  const freezeSent = Promise.withResolvers<void>();
  const freezeAcknowledged = Promise.withResolvers<void>();
  const deadline = Promise.withResolvers<never>();
  let freezeWork: Promise<unknown> | undefined;
  const tabs = twoTabs(
    async (tab, state) => {
      if (tab === 'first' && state === 'frozen') {
        freezeSent.resolve();
        await freezeAcknowledged.promise;
      }
    },
    work => {
      if (freezeWork) return work;
      freezeWork = work;
      return Promise.race([work, deadline.promise]);
    },
  );
  const outcome = tabs.capture().then(
    () => undefined,
    (error: unknown) => error,
  );
  await freezeSent.promise;
  expect(tabs.commands).toEqual([['first', 'frozen']]);

  deadline.reject(new Error('fixture capture deadline'));
  expect(await outcome).toEqual(new Error('fixture capture deadline'));
  expect(tabs.commands).toEqual([
    ['first', 'frozen'],
    ['first', 'active'],
    ['survivor', 'active'],
  ]);

  // Chrome can acknowledge an in-flight freeze after the deadline and the first restoration.
  freezeAcknowledged.resolve();
  await freezeWork;
  expect(tabs.commands).toEqual([
    ['first', 'frozen'],
    ['first', 'active'],
    ['survivor', 'active'],
    ['first', 'active'],
  ]);
  expect([...tabs.lifecycle]).toEqual([
    ['first', 'active'],
    ['survivor', 'active'],
  ]);
});
