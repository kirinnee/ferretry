import { describe, expect, test } from 'bun:test';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { ConversationOutbox } from '../../../../app/composer/conversation-outbox.tsx';
import { useSendOutbox } from '../../../../app/composer/send-outbox-wiring.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';

ensureDom();

/**
 * The outbox a chat's composers share: it is offered the client's sender, and it hears the client's feed, so a saved
 * message goes out when the machine is back.
 */

const feedOf = () => {
  const listeners = new Set<(live: boolean) => void>();
  return {
    listeners,
    feed: {
      isLive: () => true,
      subscribeLive: (listener: (live: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

function Probe({ seen }: { readonly seen: { outbox: unknown } }) {
  seen.outbox = useSendOutbox();
  return null;
}

describe('ConversationOutbox', () => {
  test('gives the composers below it their daemon’s outbox, and listens to the client’s feed while it is drawn', () => {
    const { feed, listeners } = feedOf();
    const seen = { outbox: null as unknown };
    const view = render(
      <ConversationClientProvider client={fakeClient({}, { daemon: 'outbox-feed-1', more: { feed } })}>
        <ConversationOutbox>
          <Probe seen={seen} />
        </ConversationOutbox>
      </ConversationClientProvider>,
    );
    expect(seen.outbox).not.toBeNull();
    expect(listeners.size).toBe(1);
    run(() => view.unmount());
    expect(listeners.size).toBe(0);
  });

  test('a client with no feed is offered the sender all the same', () => {
    const seen = { outbox: null as unknown };
    const view = render(
      <ConversationClientProvider client={fakeClient({}, { daemon: 'outbox-feed-2' })}>
        <ConversationOutbox>
          <Probe seen={seen} />
        </ConversationOutbox>
      </ConversationClientProvider>,
    );
    expect(seen.outbox).not.toBeNull();
    run(() => view.unmount());
  });

  test('a client the shell recorded no daemon for has no outbox to keep', () => {
    const seen = { outbox: 'unset' as unknown };
    const view = render(
      <ConversationClientProvider client={fakeClient({})}>
        <ConversationOutbox>
          <Probe seen={seen} />
        </ConversationOutbox>
      </ConversationClientProvider>,
    );
    expect(seen.outbox).toBeNull();
    run(() => view.unmount());
  });
});
