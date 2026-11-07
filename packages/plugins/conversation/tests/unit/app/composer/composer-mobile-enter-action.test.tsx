import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();

import { Composer, type ComposerProps } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { interact, mount, must } from '@ferretry/app/testing';
import { writeMdComposePref } from '@ferretry/app';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('a touch-safe send preference keeps a reachable New line action', async () => {
  const daemon = daemonConnection('mobile-daemon');
  const sessionId = 'mobile-enter';
  const drafts = new DaemonDraftStore(new MemoryStorage());
  drafts.save(daemonFerretScope(daemon, sessionId), 'BeforeAfter', 1);
  const view = await mount(
    <Composer
      api={{ send: async () => undefined } as unknown as ComposerProps['api']}
      daemon={daemon}
      draftStore={drafts}
      enterKeyPreference="send"
      phoneEnterKeyPreference="send"
      ferretId={sessionId}
    />,
  );
  try {
    // The shared modality store deliberately follows the latest input device,
    // not a viewport heuristic. A touch event makes this a mixed/touch-safe
    // reader even if happy-dom presents a fine-pointer desktop by default.
    const touch = new Event('pointerdown');
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    await interact(() => window.dispatchEvent(touch));

    const input = must(view.container.querySelector('textarea'), 'composer textarea');
    input.setSelectionRange(6, 6);
    const newline = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent === 'New line'),
      'touch-safe New line button',
    );

    await interact(() => newline.click());
    await interact(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

    expect(input.value).toBe('Before\nAfter');
    expect(input.selectionStart).toBe(7);
    expect(input.selectionEnd).toBe(7);
  } finally {
    const mouse = new Event('pointerdown');
    Object.defineProperty(mouse, 'pointerType', { value: 'mouse' });
    await interact(() => window.dispatchEvent(mouse));
    await view.unmount();
  }
});
