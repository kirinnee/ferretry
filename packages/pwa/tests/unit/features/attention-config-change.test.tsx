import { describe, expect, it } from 'bun:test';
import { AttentionConfigChange, configChangeLine } from '../../../src/features/attention/attention-config-change.tsx';
import { mount } from '../../support/dom.ts';

const PRICE = 'the Jev price the cap counts with goes down from 2 to 0.042';
const LAYER = 'the Warden may now spend on AI investigations';
const confirms = { path: 'warden.yaml', etag: 'a'.repeat(64), changes: [PRICE, LAYER] };

describe('configChangeLine', () => {
  it('reads a value that moves as its subject and its two values', () => {
    expect(configChangeLine(PRICE)).toEqual({ what: 'The Jev price the cap counts with', from: '2', to: '0.042' });
    expect(configChangeLine('the daily Jev cap in dollars goes up from 1 to 5')).toEqual({
      what: 'The daily Jev cap in dollars',
      from: '1',
      to: '5',
    });
  });

  it('keeps any other loosening as one sentence', () => {
    expect(configChangeLine(` ${LAYER} `)).toEqual({ what: 'The Warden may now spend on AI investigations' });
  });
});

describe('AttentionConfigChange', () => {
  it('draws nothing for an item that confirms no change', async () => {
    const view = await mount(<AttentionConfigChange item={{}} />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('shows the file, each change before → after, and that Allow applies it', async () => {
    const view = await mount(<AttentionConfigChange item={{ confirms }} />);
    const block = view.container.querySelector('[data-attention-confirms="warden.yaml"]');
    expect(block?.getAttribute('aria-label')).toBe('The change to warden.yaml that Allow applies');
    expect(block?.textContent).toContain('Held change to warden.yaml');
    const items = [...view.container.querySelectorAll('li')].map(item => item.textContent);
    expect(items).toEqual([
      'The Jev price the cap counts with: 2 →  becomes 0.042',
      'The Warden may now spend on AI investigations',
    ]);
    expect(view.container.querySelector('[data-attention-allow-applies]')?.textContent).toBe(
      'Allow applies this change. Deny keeps it held; Discard change puts warden.yaml back.',
    );
    expect(view.container.querySelector('[data-attention-restated]')).toBeNull();
    await view.unmount();
  });

  it('warns that a restated change was edited after the card was raised', async () => {
    const view = await mount(<AttentionConfigChange item={{ confirms: { ...confirms, restated: true } }} />);
    expect(view.container.querySelector('[data-attention-restated]')?.textContent).toBe(
      'This change was edited after it was raised. Read it again before you answer.',
    );
    await view.unmount();
  });
});
