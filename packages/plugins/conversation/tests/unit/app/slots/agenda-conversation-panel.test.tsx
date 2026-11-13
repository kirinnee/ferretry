import { describe, expect, test } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { ensureDom, mount, type Mounted, runAsync } from '@ferretry/app/testing';
import {
  AgendaConversationPanel,
  isAgendaConversationProps,
} from '../../../../app/slots/agenda-conversation-panel.tsx';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { ferretSummary } from '../../../support/app/ferret-view.ts';

ensureDom();

const daemon = () =>
  fakeClient(
    {
      'GET /v1/ferrets/:ferretId': call => ferretSummary(call.params['ferretId'] ?? ''),
      'GET /v1/ferrets/:ferretId/log-page': call => ({
        v: 1,
        ferret: call.params['ferretId'],
        log: '',
        start: 0,
        file: 'f1',
      }),
      'GET /v1/ferrets/:ferretId/sends': () => ({ sends: [] }),
      'GET /v1/ferrets/:ferretId/queue': () => ({ messages: [] }),
      'GET /v1/ferrets/:ferretId/question': () => ({ question: null }),
    },
    'alpha',
  );

const open = async (props: object): Promise<{ mounted: Mounted; client: ReturnType<typeof daemon> }> => {
  const client = daemon();
  const mounted = await mount(
    <ConversationClientProvider client={client}>
      <AgendaConversationPanel {...(props as PanelProps)} />
    </ConversationClientProvider>,
  );
  await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 50)));
  return { mounted, client };
};

describe('the open ask’s conversation (slot agenda.conversation)', () => {
  test('narrows the slot’s props to a ferret and an ask', () => {
    expect(isAgendaConversationProps({ ferret: 'f1', ask: 'A3' })).toBe(true);
    expect(isAgendaConversationProps({ ferret: 'f1' })).toBe(false);
    expect(isAgendaConversationProps(null)).toBe(false);
    expect(isAgendaConversationProps('f1')).toBe(false);
  });

  test('draws that ferret’s conversation under the ask: its chat is read from the daemon', async () => {
    const { mounted, client } = await open({ ferret: 'f1', ask: 'A3' });
    expect(client.callsTo('GET /v1/ferrets/:ferretId').map(call => call.params['ferretId'])).toContain('f1');
    expect(mounted.container.textContent).not.toContain('names no ferret');
    await mounted.unmount();
  });

  test('draws nothing when the slot hands something else, or a blank ferret', async () => {
    for (const props of [{}, { ferret: '  ', ask: 'A3' }]) {
      const { mounted, client } = await open(props);
      expect(mounted.container.innerHTML).toBe('');
      expect(client.calls).toEqual([]);
      await mounted.unmount();
    }
  });
});
