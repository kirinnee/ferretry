/**
 * The browser entry for "the composer is one clean row and a quiet status line": the REAL `Composer` in the real chat
 * page's column structure. Its status line is handed Runtimes' model chip and Usage's quota as stand-ins (an app test reaches
 * another package only through its contract), each in the markup and classes the real panel draws and inside the
 * `.fy-slot` › `.fy-panel` wrappers the slot draws them in. Which panels the slot sends where is the unit test's
 * (`composer-status-line.test.tsx`); this scene proves the geometry. Everything on screen is fake data; no daemon.
 *
 *   ?compact=1            the phone's composer
 *   ?usage=known|unknown  whether the quota readout has a number (unknown draws nothing, as the real panel does)
 *   ?theme=<family>-<mode>
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { SlidersHorizontal } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { Composer } from '../../../../app/composer/composer.tsx';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const compact = params.get('compact') === '1';
const known = params.get('usage') === 'known';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
const store = new DaemonDraftStore(storage);
const client = { call: async () => ({}) } as unknown as PluginClient;
const daemon = daemonConnection('daemon-status');
const api = { send: async () => ({ disposition: 'queued' }) as never };

/** Runtimes' `runtime-picker` panel: one chip, the model in force (and, once built, thinking and speed). */
const RuntimePicker = () => (
  <div className="fy-runtime-picker shrink-0" data-runtime-picker="zoe">
    <button
      aria-label="Change model and reasoning — claude-opus-5-5"
      className="kt-btn fy-runtime-chip !w-auto inline-flex max-w-[9rem] min-w-0 items-center justify-center gap-1 px-2 py-1 text-meta"
      data-runtime-chip=""
      type="button"
    >
      <SlidersHorizontal aria-hidden="true" className="shrink-0" size={14} />
      <span className="min-w-0 truncate">{params.get('chip') ?? 'claude-opus-5-5 · high · fast'}</span>
    </button>
  </div>
);

/** Usage's `composer-quota` panel, as it draws today: nothing visible while the usage is unknown. */
const Quota = () =>
  known ? (
    <span className="fy-composer-quota" data-quota="known">
      <span aria-hidden="true">
        <span>5h 12%</span>
        <span className="fy-quota-divider">·</span>
        <span>wk 38%</span>
      </span>
    </span>
  ) : (
    <span className="fy-composer-quota" data-quota="unknown">
      <span className="sr-only">Account usage unknown: the daemon has no reading for this account yet.</span>
    </span>
  );

/** The status line's two panels, each in the wrappers the slot draws them in (`.fy-slot` › `.fy-panel`). */
const status = (
  <div className="fy-slot" data-slot="composer.tools">
    <div className="fy-panel" data-panel="runtimes.runtime-picker">
      <RuntimePicker />
    </div>
    <div className="fy-panel" data-panel="usage.composer-quota">
      <Quota />
    </div>
  </div>
);

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
            <Composer
              api={api}
              compact={compact}
              daemon={daemon}
              draftStore={store}
              ferretId="zoe"
              placeholder="Message this ferret"
              statusSlot={status}
            />
          </div>
        </div>
      </div>
    </main>
  </ConversationClientProvider>,
);
