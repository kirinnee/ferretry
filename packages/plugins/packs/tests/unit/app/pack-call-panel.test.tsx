import { afterEach, describe, expect, test } from 'bun:test';
import type { ConversationRowEntry } from '@ferretry/plugin-conversation/contract';
import { createPanel } from '../../../app/views/pack-call-panel.tsx';
import { type Mounted, mount } from '../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const scripted = () => {
  const calls: string[] = [];
  return {
    calls,
    client: {
      call: async (key: string) => {
        calls.push(key);
        throw new Error('offline');
      },
    } as never,
  };
};

const entry = (command: string, text = ''): ConversationRowEntry => ({
  id: 'tools:k1',
  kind: 'tool',
  text: 'ran a tool',
  tools: [{ key: 'k1', name: 'Bash', command, result: { text } }],
});

describe('the Pack card as a conversation.row panel', () => {
  test('a row with a Pack start draws its card, reading the lead’s pack table once', async () => {
    const api = scripted();
    const Panel = createPanel(api.client);
    view = await mount(
      <Panel
        entry={entry(
          'fy new --runtime claude-auto-work "go"',
          'Started nadia (mvnadia-1) on claude-auto-work — decided by you.',
        )}
        subject="lead"
      />,
    );
    const card = view.container.querySelector('.fy-message-pack');
    expect(card?.getAttribute('data-pack-kind')).toBe('start');
    expect(card?.getAttribute('data-transcript-density')).toBe('message');
    expect(card?.textContent).toContain('Started helper');
    expect(api.calls).toEqual(['GET /v1/ferrets/:ferretId/pack']);
  });

  test('a row with no Pack command draws nothing and asks the machine nothing', async () => {
    const api = scripted();
    const Panel = createPanel(api.client);
    view = await mount(<Panel entry={entry('ls -la')} subject="lead" />);
    expect(view.container.querySelector('.fy-message-pack')).toBeNull();
    expect(api.calls).toEqual([]);
  });

  test('without a ferret or a row it draws nothing', async () => {
    const Panel = createPanel(scripted().client);
    view = await mount(<Panel subject="lead" />);
    expect(view.container.innerHTML).toBe('');
  });
});
