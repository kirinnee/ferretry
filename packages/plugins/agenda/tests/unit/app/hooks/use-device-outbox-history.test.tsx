/**
 * The owner's words still on this device, as one item's History events: nothing without Conversation's hook, and only
 * the messages that name the item with it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, type Mounted, mount, WithAppHooks } from '@ferretry/app/testing';
import {
  CONVERSATION_DEVICE_OUTBOX_HOOK,
  type ConversationDeviceOutbox,
  type DeviceOutboxEntry,
} from '@ferretry/plugin-conversation/contract';
import { useDeviceOutboxHistory } from '../../../../app/hooks/use-device-outbox-history.ts';

ensureDom();

const SCOPE = { daemonId: 'fy_daemon_x', sessionId: 'ferret-1' } as const;

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function Probe({ scope }: { readonly scope: typeof SCOPE | null }) {
  const events = useDeviceOutboxHistory(scope, 'A3');
  return <output>{JSON.stringify(events.map(event => (event.kind === 'owner' ? event.text : event.kind)))}</output>;
}

const entry = (over: Partial<DeviceOutboxEntry>): DeviceOutboxEntry => ({
  id: 'send-1',
  ferretId: 'ferret-1',
  message: 'hello',
  references: ['^A3'],
  createdAt: '2026-08-01T10:02:00.000Z',
  ...over,
});

// Like the real hook, the same array for a ferret until its entries change.
const outboxOf = (entries: readonly DeviceOutboxEntry[]): ConversationDeviceOutbox => {
  const kept = new Map<string, readonly DeviceOutboxEntry[]>();
  return {
    subscribe: () => () => undefined,
    entries: ferret => {
      const held = kept.get(ferret) ?? entries.filter(entry => entry.ferretId === ferret);
      kept.set(ferret, held);
      return held;
    },
  };
};

const read = async (provided: Record<string, unknown>, scope: typeof SCOPE | null = SCOPE): Promise<string> => {
  mounted = await mount(
    <WithAppHooks provided={provided}>
      <Probe scope={scope} />
    </WithAppHooks>,
  );
  return mounted.container.querySelector('output')?.textContent ?? '';
};

describe('useDeviceOutboxHistory', () => {
  it('is empty with no provider, so the History draws as it always did', async () => {
    expect(await read({})).toBe('[]');
  });

  it('is empty without a ferret to ask about', async () => {
    const provided = { [CONVERSATION_DEVICE_OUTBOX_HOOK]: outboxOf([entry({})]) };
    expect(await read(provided, null)).toBe('[]');
  });

  it('is empty for a value of another shape', async () => {
    expect(await read({ [CONVERSATION_DEVICE_OUTBOX_HOOK]: { entries: 1 } })).toBe('[]');
  });

  it('gives the words of this ferret that name the item, and no others', async () => {
    const provided = {
      [CONVERSATION_DEVICE_OUTBOX_HOOK]: outboxOf([
        entry({ id: 'a', message: 'mine' }),
        entry({ id: 'b', message: 'about nine', references: ['^A9'] }),
        entry({ id: 'c', message: 'other ferret', ferretId: 'ferret-2' }),
      ]),
    };
    expect(await read(provided)).toBe('["mine"]');
  });
});
