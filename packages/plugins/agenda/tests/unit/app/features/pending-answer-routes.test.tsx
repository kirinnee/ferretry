import { afterEach, expect, it } from 'bun:test';
import { ensureDom, interact, mount, type Mounted, must, settleUntil } from '@ferretry/app/testing';
import { answerReceipts } from '../../../../app/lib/answer-receipts.ts';
import { pendingAnswerRoutes } from '../../../support/app/pending-answer-routes.tsx';
import { openConversation } from '../../../support/app/agenda-folds.ts';

ensureDom();
let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  answerReceipts.update(() => ({ pending: [], sending: [], failed: [] }));
  window.history.replaceState({}, '', '/');
});

for (const via of ['inbox', 'chat-line'] as const)
  it(`reopens the answered item via the real ${via} route DURING its undo hold`, async () => {
    const scene = pendingAnswerRoutes();
    window.history.replaceState({}, '', '/d/this/agenda');
    view = await mount(<scene.Scene />);
    const root = view.container;
    const click = (selector: string) =>
      interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
    await settleUntil(
      () => root.querySelector('[data-agenda-row]') !== null,
      () => root.textContent ?? '',
      interact,
    );
    await click('[data-agenda-row*="A2"]');
    await click('.fy-attn-deck__top [data-agenda-option="Ship"]');
    expect(scene.state().pending).toHaveLength(1);
    expect(scene.commits).toHaveLength(0);
    await interact(() => scene.go(via === 'inbox' ? '/d/this/agenda?ask=A2&session=sess-1' : '/d/this/session/sess-1'));
    if (via === 'chat-line') {
      await settleUntil(
        () => root.querySelector('[data-agenda-line-toggle]') !== null,
        () => root.textContent ?? '',
        interact,
      );
      await click('[data-agenda-line-toggle]');
      await click('[data-agenda-row="A2"]');
    }
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 450));
    });
    expect(scene.state().pending, 'the real route kept the undo hold').toHaveLength(1);
    expect(scene.commits, 'no flush before the History assertion').toHaveLength(0);
    expect(root.querySelector('.fy-attn-deck__top [data-agenda-view]')?.getAttribute('data-agenda-view')).toBe('A2');
    await openConversation(root);
    expect(root.querySelectorAll('[data-agenda-history] [data-history="owner"]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-history]')?.textContent).toContain('Ship');
    await click('[data-agenda-undo-button]');
    expect(root.querySelectorAll('[data-agenda-history] [data-history="owner"]')).toHaveLength(0);
    expect(scene.commits).toHaveLength(0);
  });

it('pagehide still sends a held answer after navigating from Inbox into the real chat line', async () => {
  const scene = pendingAnswerRoutes();
  window.history.replaceState({}, '', '/d/this/agenda');
  view = await mount(<scene.Scene />);
  const root = view.container;
  const click = (selector: string) => interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
  await settleUntil(
    () => root.querySelector('[data-agenda-row]') !== null,
    () => root.textContent ?? '',
    interact,
  );
  await click('[data-agenda-row*="A2"]');
  await click('.fy-attn-deck__top [data-agenda-option="Ship"]');
  await interact(() => scene.go('/d/this/session/sess-1'));
  expect(scene.state().pending).toHaveLength(1);
  expect(scene.commits).toHaveLength(0);
  await interact(() => window.dispatchEvent(new Event('pagehide')));
  expect(scene.state().pending).toHaveLength(0);
  expect(scene.commits).toHaveLength(1);
  await interact(async () => {
    scene.commits[0]?.reject(new Error('Offline'));
    await Promise.resolve();
  });
  await interact(() => scene.go('/d/this/agenda?ask=A2&session=sess-1'));
  await openConversation(root);
  expect(root.querySelector('[data-agenda-history] [data-send-receipt="failed"]')).not.toBeNull();
  expect(root.querySelector('[data-agenda-history]')?.textContent).toContain('Offline');
});
