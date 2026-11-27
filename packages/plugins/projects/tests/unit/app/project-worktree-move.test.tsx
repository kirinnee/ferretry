import { describe, expect, test } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import { ProjectWorktrees } from '../../../app/features/worktrees/project-worktrees.tsx';
import { PROJECT, scripted, clickEvent, refusal, type Call } from './support/client.ts';
import { LIST, listAnswer, row } from './support/worktree-fixtures.ts';

const MOVE = 'POST /v1/worktrees/move';
const FROM = '/work/old-checkout';
const TO = '/home/fake/.ferretry-worktrees/project-id/repo/feature';
const OFFER = { worktreeId: 'worktree-1', destination: TO, reviewedIdentity: 'a'.repeat(64) };
const click = async (selector: string) =>
  await interact(() => must(document.querySelector(selector), selector).dispatchEvent(clickEvent()));

async function fixture(denied = false) {
  const calls: Call[] = [];
  let moved = false;
  const client = scripted(
    {
      [LIST]: () =>
        listAnswer('/work/repo/.git', [
          row('/work/repo', 'main', {
            main: true,
            move: { worktreeId: 'main', reason: 'The main checkout cannot move.' },
          }),
          row(moved ? TO : FROM, 'feature', {
            move: moved ? { worktreeId: 'worktree-1', reason: 'It is already in the project’s worktree root.' } : OFFER,
          }),
          row('/work/dirty', 'dirty', { move: { worktreeId: 'dirty', reason: 'The checkout has uncommitted files.' } }),
        ]),
      [MOVE]: (call: Call) => {
        if (denied) throw refusal(409, 'a live ferret started here');
        expect(call.body).toEqual({
          project: PROJECT.id,
          worktreeId: OFFER.worktreeId,
          reviewedIdentity: OFFER.reviewedIdentity,
        });
        moved = true;
        return { from: FROM, to: TO };
      },
    },
    calls,
  );
  const mounted = await mount(
    <ProjectWorktrees client={client} project={{ ...PROJECT, git: { commonDirectory: '/work/repo/.git' } }} />,
  );
  await settleUntil(
    () => document.querySelector('[data-project-worktree-move]') !== null,
    'the offered move',
    interact,
  );
  return { mounted, calls };
}

describe('project worktree move confirmation', () => {
  test('only the offered row has a button; opening and cancelling sends no move', async () => {
    const w = await fixture();
    expect(document.querySelectorAll('[data-project-worktree-move]').length).toBe(1);
    expect(document.querySelectorAll('[data-project-worktree-no-move]').length).toBe(2);
    await click('[data-project-worktree-move]');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(FROM);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(TO);
    expect(w.calls.filter(call => call.route === MOVE)).toHaveLength(0);
    await interact(() => {
      const cancel = [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
      must(cancel, 'Cancel').dispatchEvent(clickEvent());
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(w.calls.filter(call => call.route === MOVE)).toHaveLength(0);
    await w.mounted.unmount();
  });

  test('confirmation sends only the daemon-issued id and identity, then lists the new path', async () => {
    const w = await fixture();
    await click('[data-project-worktree-move]');
    await click('[data-project-worktree-confirm-move]');
    await settleUntil(
      () => document.querySelector(`[data-project-worktree="${TO}"]`) !== null,
      'the new path',
      interact,
    );
    expect(w.calls.filter(call => call.route === MOVE)).toHaveLength(1);
    expect(document.querySelector(`[data-project-worktree="${FROM}"]`)).toBeNull();
    await w.mounted.unmount();
  });

  test('an apply-time refusal stays visible in the sheet with both reviewed paths', async () => {
    const w = await fixture(true);
    await click('[data-project-worktree-move]');
    await click('[data-project-worktree-confirm-move]');
    await settleUntil(() => document.querySelector('[role="alert"]') !== null, 'the live refusal', interact);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('a live ferret started here');
    expect(document.querySelector(`[data-project-worktree="${FROM}"]`)).not.toBeNull();
    await w.mounted.unmount();
  });
});
