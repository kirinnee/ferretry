import { afterEach, describe, expect, it } from 'bun:test';
import { type Mounted, mount } from '@ferretry/app/testing';
import { ChatTurnContext } from '../../../../app/chat/chat-turn-context.ts';
import { TurnPanel } from '../../../../app/toolbar/turn-panel.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const turnOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-ferret-turn]');

describe('whose turn it is, in the ferret toolbar', () => {
  it('says the chat’s own reading in words: working, needs you — and not “Your turn”, which the status mark beside it already says', async () => {
    mounted = await mount(
      <ChatTurnContext.Provider value={{ ferret: 'ferret-hadi', turnState: 'working' }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
    );
    expect(turnOf(mounted.container)?.textContent).toBe('Working');

    await mounted.render(
      <ChatTurnContext.Provider value={{ ferret: 'ferret-hadi', turnState: 'your-turn' }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
    );
    // The ferret's status mark (an idle ferret) says "your turn" beside this panel, so the word is drawn once, not twice.
    expect(turnOf(mounted.container)).toBeNull();

    await mounted.render(
      <ChatTurnContext.Provider value={{ ferret: 'ferret-hadi', turnState: 'needs-input' }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
    );
    expect(turnOf(mounted.container)?.getAttribute('data-ferret-turn')).toBe('needs-input');
    expect(turnOf(mounted.container)?.textContent).toBe('Needs you');
  });

  it('draws nothing when the chat read no turn, another ferret’s turn, no chat above it, or it has no ferret', async () => {
    for (const tree of [
      <ChatTurnContext.Provider key="none" value={{ ferret: 'ferret-hadi', turnState: undefined }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
      <ChatTurnContext.Provider key="other" value={{ ferret: 'someone-else', turnState: 'working' }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
      <TurnPanel key="no-chat" subject="ferret-hadi" />,
      <ChatTurnContext.Provider key="no-subject" value={{ ferret: 'ferret-hadi', turnState: 'working' }}>
        <TurnPanel />
      </ChatTurnContext.Provider>,
    ]) {
      const view = await mount(tree);
      try {
        expect(turnOf(view.container)).toBeNull();
      } finally {
        await view.unmount();
      }
    }
  });

  it('says "Compacting" while the page’s live sample says a compaction runs, whatever the turn, and only for its own ferret', async () => {
    const compacting = (ferret: string, turnState: 'working' | 'your-turn' | undefined) => (
      <ChatTurnContext.Provider value={{ ferret, turnState, compacting: true }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>
    );
    mounted = await mount(compacting('ferret-hadi', 'working'));
    expect(turnOf(mounted.container)?.textContent).toBe('Compacting');
    expect(turnOf(mounted.container)?.hasAttribute('data-ferret-compacting')).toBe(true);

    await mounted.render(compacting('ferret-hadi', 'your-turn'));
    expect(turnOf(mounted.container)?.textContent).toBe('Compacting');

    // Not told for another ferret, and never drawn for a ferret whose turn the chat did not read.
    await mounted.render(compacting('someone-else', 'working'));
    expect(turnOf(mounted.container)).toBeNull();
    await mounted.render(compacting('ferret-hadi', undefined));
    expect(turnOf(mounted.container)).toBeNull();
  });

  it('is back to the turn word once the compaction is not running', async () => {
    mounted = await mount(
      <ChatTurnContext.Provider value={{ ferret: 'ferret-hadi', turnState: 'working', compacting: false }}>
        <TurnPanel subject="ferret-hadi" />
      </ChatTurnContext.Provider>,
    );
    expect(turnOf(mounted.container)?.textContent).toBe('Working');
    expect(turnOf(mounted.container)?.hasAttribute('data-ferret-compacting')).toBe(false);
  });
});
