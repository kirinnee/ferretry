import { afterEach, describe, expect, it } from 'bun:test';
import { MovePage } from '../../../../app/features/move/move-page.tsx';
import { type Call, scripted } from '../support/client.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { chosenAccount, fakeSlot } from './slot.tsx';
import { readyPreview, summaryOf } from './support.ts';

let live: Mounted | undefined;
afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const FERRET = summaryOf({
  id: 'f-1',
  harness: 'claude-code',
  runtime: 'claude-default',
  model: 'claude-opus-5',
  state: 'idle',
});
const text = (root: HTMLElement): string => root.textContent ?? '';
const control = (root: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label)),
    `the ${label} button`,
  );
const click = async (node: HTMLElement): Promise<void> => {
  await interact(() => node.click());
  await settle();
};

const show = async (routes: Parameters<typeof scripted>[0], calls: Call[] = []) => {
  let closes = 0;
  live = await mount(
    <MovePage
      client={scripted(routes, calls)}
      ferret="f-1"
      onClose={() => {
        closes += 1;
      }}
      slot={fakeSlot([chosenAccount('claude-b', 'claude-code'), chosenAccount('codex-a', 'codex')])}
    />,
  );
  await settle();
  return { root: live.container, closes: () => closes };
};

describe('MovePage', () => {
  it('reads the ferret by id and draws its name, with both ways to move', async () => {
    const calls: Call[] = [];
    const { root } = await show({ 'GET /v1/ferrets/:ferretId': FERRET }, calls);
    expect(calls[0]).toMatchObject({ route: 'GET /v1/ferrets/:ferretId', params: { ferretId: 'f-1' } });
    expect(text(root)).toContain('Move Hadi');
    expect(control(root, 'Change model or account').getAttribute('aria-pressed')).toBe('true');
    expect(control(root, 'Move to Codex')).toBeDefined();
  });

  it('says a failed read, and reads again on Try again', async () => {
    let attempts = 0;
    const { root } = await show({
      'GET /v1/ferrets/:ferretId': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the daemon is unreachable');
        return FERRET;
      },
    });
    expect(text(must(root.querySelector('[data-move-failed]'), 'failure'))).toContain('the daemon is unreachable');
    await click(control(root, 'Try again'));
    expect(text(root)).toContain('Move Hadi');
  });

  it('moves onto another account of its CLI and shows the done line, then goes back to the ferret', async () => {
    const calls: Call[] = [];
    const { root, closes } = await show(
      {
        'GET /v1/ferrets/:ferretId': FERRET,
        'POST /v1/ferrets/:ferretId/move': summaryOf({ id: 'f-1', runtime: 'claude-b' }),
      },
      calls,
    );
    await click(must(root.querySelector<HTMLElement>('[data-account="claude-b"]'), 'account'));
    await interact(() =>
      must(root.querySelector('form'), 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await click(control(root, 'Move and relaunch'));
    expect(calls.at(-1)).toMatchObject({
      route: 'POST /v1/ferrets/:ferretId/move',
      params: { ferretId: 'f-1' },
      body: { agent: 'claude-b', model: 'claude-opus-5', allowContextDowngrade: false, forceInflight: false },
    });
    expect(text(must(root.querySelector('[data-move-done]'), 'done')).includes('Moved to claude-b.')).toBe(true);
    await click(must(root.querySelector<HTMLElement>('[data-move-open]'), 'back'));
    expect(closes()).toBe(1);
  });

  it('switches to the other CLI, and converts with the conversation-convert request', async () => {
    const calls: Call[] = [];
    const { root } = await show(
      {
        'GET /v1/ferrets/:ferretId': FERRET,
        'POST /v1/ferrets/:ferretId/conversion-preview': { ...readyPreview },
        'POST /v1/ferrets/:ferretId/move': summaryOf({ id: 'f-1', harness: 'codex', runtime: 'codex-a' }),
      },
      calls,
    );
    await click(control(root, 'Move to Codex'));
    expect(control(root, 'Move to Codex').getAttribute('aria-pressed')).toBe('true');
    await click(must(root.querySelector<HTMLElement>('[data-account="codex-a"]'), 'account'));
    await click(must(root.querySelector<HTMLElement>('[data-convert-confirm]'), 'confirm'));
    expect(calls.at(-1)?.body).toEqual({
      agent: 'codex-a',
      allowContextDowngrade: false,
      forceInflight: false,
      conversation: 'convert',
    });
    expect(text(root)).toContain('Moved to Codex (codex-a).');
  });

  it('shows the daemon’s own sentence for a refused move, and the ferret is left as it was', async () => {
    const forbidden = Object.assign(new Error('this device may not move ferrets'), { status: 403, code: 'forbidden' });
    const { root } = await show({
      'GET /v1/ferrets/:ferretId': FERRET,
      'POST /v1/ferrets/:ferretId/move': forbidden,
    });
    await click(must(root.querySelector<HTMLElement>('[data-account="claude-b"]'), 'account'));
    await interact(() =>
      must(root.querySelector('form'), 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await click(control(root, 'Move and relaunch'));
    expect(text(root)).toContain('this device may not move ferrets');
    expect(root.querySelector('[data-move-done]')).toBeNull();
  });
});
