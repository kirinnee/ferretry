/**
 * The browser entry for "the composer is one clean row and a quiet status line": the REAL `Composer` in the real chat
 * page's column structure, its `composer.tools` slot filled by the shell's own slot machinery (`WithSlotPanels`). Conversation's
 * own panel (attach) is the real one; Voice's mic, Runtimes' three readouts and Usage's quota are stand-ins (an app test
 * reaches another package only through its contract), each in the markup and classes the real panel draws. Which panels
 * the slot sends where is the unit test's (`composer-status-line.test.tsx`); this scene proves the geometry. Everything on
 * screen is fake data; no daemon.
 *
 *   ?compact=1                     the phone's composer
 *   ?usage=known|key|unknown       a subscription login's 5h + weekly, a key login's money spent, or nothing known (draws nothing)
 *   ?theme=<palette>-<mode>   ?style=<look family>
 */

import { WithSlotPanels } from '@ferretry/app/testing/settings-shell';
import { Button } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { Brain, Mic, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { ComposerAttachPanel } from '../../../../app/composer/composer-attach.tsx';
import { Composer } from '../../../../app/composer/composer.tsx';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
// `?style=genz` puts the look family (the loud ones draw hard offset shadows) over the palette the theme names.
const style = params.get('style');
if (style !== null) document.documentElement.dataset.style = style;
const compact = params.get('compact') === '1';
const usage = params.get('usage') ?? 'unknown';

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

/** Voice's `dictation` panel: the ghost `Button` it draws, in the composer's row. */
const Dictation = () => (
  <Button
    aria-label="Dictate"
    className="min-h-[44px] min-w-[44px] select-none px-2"
    size="sm"
    type="button"
    variant="ghost"
  >
    <Mic aria-hidden="true" size={15} />
  </Button>
);

const chip = (key: string, text: string, icon?: ReactNode) => (
  <button
    aria-label={`Change the ${key}`}
    className="kt-btn fy-runtime-chip !w-auto inline-flex min-w-0 items-center justify-center gap-1 px-1 py-1 text-meta"
    data-runtime-chip={key}
    type="button"
  >
    {icon}
    <span>{text}</span>
  </button>
);

/** Runtimes' `runtime-picker` panel: the model, the thinking level and the speed, three quiet readouts. */
const RuntimePicker = () => (
  <div className="fy-runtime-picker shrink-0" data-runtime-picker="zoe">
    {chip('model', params.get('model') ?? 'claude-opus-5-5')}
    {chip('effort', 'high', <Brain aria-hidden="true" className="shrink-0" size={12} />)}
    {chip('speed', params.get('speed') ?? 'Fast', <Zap aria-hidden="true" className="shrink-0" size={12} />)}
  </div>
);

/** Usage's `composer-quota` panel, as it draws: the windows, the money a key login spent, or NOTHING while unknown. */
const Quota = () =>
  usage === 'known' ? (
    <span className="fy-composer-quota" data-quota="known">
      <span aria-hidden="true">
        <span>5h 12%</span>
        <span className="fy-quota-divider">·</span>
        <span>wk 38%</span>
      </span>
    </span>
  ) : usage === 'key' ? (
    <span className="fy-composer-quota" data-quota="known">
      <span aria-hidden="true" className="text-faint">
        $3.20 this month
      </span>
    </span>
  ) : null;

const slots = {
  'composer.tools': [
    { plugin: 'conversation', id: 'attachments', view: () => <ComposerAttachPanel /> },
    { plugin: 'voice', id: 'dictation', view: () => <Dictation /> },
    { plugin: 'runtimes', id: 'runtime-picker', view: () => <RuntimePicker /> },
    { plugin: 'usage', id: 'composer-quota', view: () => <Quota /> },
  ],
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
            <WithSlotPanels slots={slots}>
              <Composer
                api={api}
                compact={compact}
                daemon={daemon}
                draftStore={store}
                ferretId="zoe"
                placeholder="Message this ferret"
              />
            </WithSlotPanels>
          </div>
        </div>
      </div>
    </main>
  </ConversationClientProvider>,
);
