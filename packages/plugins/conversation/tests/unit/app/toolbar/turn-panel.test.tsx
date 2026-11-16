import { afterEach, describe, expect, it } from 'bun:test';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { interact, type Mounted, mount, settleUntil } from '@ferretry/app/testing';
import { TurnPanel } from '../../../../app/toolbar/turn-panel.tsx';
import { withClient } from '../../../support/app/client.tsx';
import { type CallHandler, fakeClient, refusal } from '../../../support/app/fake-client.ts';

const PROMPT = 'GET /v1/ferrets/:ferretId/prompt';
const FERRET = 'GET /v1/ferrets/:ferretId';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = (ready: () => boolean, what: string) => settleUntil(ready, what, interact);
const turnOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-ferret-turn]');
const answers = (prompt: CallHandler, state: CallHandler = () => ({ state: 'working' })) => ({
  [PROMPT]: prompt,
  [FERRET]: state,
});

describe('whose turn it is, in the ferret toolbar', () => {
  it('says the observer’s turn in words: working, your turn, needs you', async () => {
    let turnState = 'working';
    const client = fakeClient(answers(() => ({ turnState })));
    mounted = await mount(withClient(client, <TurnPanel subject="ferret-hadi" />));
    const root = mounted.container;
    await settle(() => turnOf(root)?.textContent === 'Working', 'Working');
    // It reads the prompt route for THIS ferret, and nothing else about the turn.
    expect(client.callsTo(PROMPT)[0]?.params).toEqual({ ferretId: 'ferret-hadi' });

    turnState = 'your-turn';
    await interact(() => client.emit(FerretsChanged.name, { ferret: 'someone-else' }));
    expect(turnOf(root)?.textContent).toBe('Working');
    await interact(() => client.emit(FerretsChanged.name, { ferret: 'ferret-hadi' }));
    await settle(() => turnOf(root)?.textContent === 'Your turn', 'Your turn');

    turnState = 'needs-input';
    await interact(() => client.emit(FerretsChanged.name, { ferret: 'ferret-hadi' }));
    await settle(() => turnOf(root)?.getAttribute('data-ferret-turn') === 'needs-input', 'needs input');
    expect(turnOf(root)?.textContent).toBe('Needs you');
  });

  it('draws nothing for a stopped ferret, one the observer said nothing about, or a prompt route that is not there', async () => {
    for (const handlers of [
      answers(
        () => ({ turnState: 'working' }),
        () => ({ state: 'stopped' }),
      ),
      answers(() => ({})),
      answers(() => {
        throw refusal(404, 'not-found', 'no prompt route');
      }),
      answers(
        () => ({ turnState: 'working' }),
        () => {
          throw refusal(404, 'not-found', 'no ferret');
        },
      ),
    ]) {
      const client = fakeClient(handlers);
      const view = await mount(withClient(client, <TurnPanel subject="ferret-hadi" />));
      try {
        await settle(() => client.callsTo(PROMPT).length > 0 && client.callsTo(FERRET).length > 0, 'both reads');
        await interact(async () => await new Promise(done => setTimeout(done, 10)));
        expect(turnOf(view.container)).toBeNull();
      } finally {
        await view.unmount();
      }
    }
  });

  it('asks nothing and draws nothing without a ferret', async () => {
    const client = fakeClient(answers(() => ({ turnState: 'working' })));
    mounted = await mount(withClient(client, <TurnPanel />));
    expect(turnOf(mounted.container)).toBeNull();
    expect(client.calls).toEqual([]);
  });
});
