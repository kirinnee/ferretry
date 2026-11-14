/**
 * The browser entry for "the ferret page's composer sends": the REAL `Composer` in the real chat page's column structure
 * (`.kt-chat-surface` › `.fy-chat-log` + `.fy-chat-input`, inside the `main` the page draws, which clips what overflows
 * it), fed a fake daemon that records every send. Fake data only; no network, no real daemon.
 *
 *   ?compact=1       the phone's composer (`compact`)
 *   ?theme=<family>-<mode>
 *
 * `window.__sent` is every message the composer sent, in order.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { Composer } from '../../../../app/composer/composer.tsx';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const compact = params.get('compact') === '1';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const sent: { ferretId: string; message: string }[] = [];
(window as unknown as { __sent: typeof sent }).__sent = sent;

const client = { call: async () => ({}) } as unknown as PluginClient;
const daemon = daemonConnection('daemon-send');
const store = new DaemonDraftStore(new MemoryStorage());

const api = {
  send: async (ferretId: string, input: { readonly message: string }) => {
    sent.push({ ferretId, message: input.message });
    return { disposition: 'queued' } as never;
  },
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <ConversationClientProvider client={client}>
    <main
      className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
      data-session="zoe"
      style={{ position: 'fixed', inset: 0 }}
    >
      <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>Fixture running · zoe</header>
      <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat="" data-chat-width="balanced">
        <div className="fy-chat-log">
          <div className="fy-chat-log__messages" data-chat-messages="">
            <p style={{ padding: 16 }}>Fake conversation: the log fills what the composer leaves.</p>
          </div>
        </div>
        <div className="fy-chat-input" data-safe-bottom="" data-session-input="">
          <div className="fy-chat-input__column">
            <Composer api={api} compact={compact} daemon={daemon} draftStore={store} ferretId="zoe" />
          </div>
        </div>
      </div>
    </main>
  </ConversationClientProvider>,
);
