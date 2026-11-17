import { describe, expect, it } from 'bun:test';
import { AgendaConfigChange, configChangeLine } from '../../../../app/features/agenda/agenda-config-change.tsx';
import { mount } from '@ferretry/app/testing';

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

describe('AgendaConfigChange', () => {
  it('draws nothing for an item that confirms no change', async () => {
    const view = await mount(<AgendaConfigChange item={{}} />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('shows the file, each change before → after, and that Allow applies it', async () => {
    const view = await mount(<AgendaConfigChange item={{ confirms }} />);
    const block = view.container.querySelector('[data-agenda-confirms="warden.yaml"]');
    expect(block?.getAttribute('aria-label')).toBe('The change to warden.yaml that Allow applies');
    expect(block?.textContent).toContain('Held change to warden.yaml');
    const items = [...view.container.querySelectorAll('li')].map(item => item.textContent);
    expect(items).toEqual([
      'The Jev price the cap counts with: 2 →  becomes 0.042',
      'The Warden may now spend on AI investigations',
    ]);
    expect(view.container.querySelector('[data-agenda-allow-applies]')?.textContent).toBe(
      'Allow applies this change. Deny keeps it held; Discard change puts warden.yaml back.',
    );
    expect(view.container.querySelector('[data-agenda-restated]')).toBeNull();
    await view.unmount();
  });

  it('warns that a restated change was edited after the card was raised', async () => {
    const view = await mount(<AgendaConfigChange item={{ confirms: { ...confirms, restated: true } }} />);
    expect(view.container.querySelector('[data-agenda-restated]')?.textContent).toBe(
      'This change was edited after it was raised. Read it again before you answer.',
    );
    await view.unmount();
  });

  it('E9 held text: links to the machine’s Configuration files, where the held edit is read in full', async () => {
    const view = await mount(<AgendaConfigChange daemonId="studio" item={{ confirms }} />);
    const link = view.container.querySelector<HTMLAnchorElement>('[data-agenda-held-text-link]');
    expect(link?.getAttribute('href')).toBe('/d/studio/settings/kernel/files');
    expect(link?.textContent).toBe('Read the held text of warden.yaml');
    await view.unmount();
  });

  it('E9 held text: without a machine, says where to read the held text instead of linking', async () => {
    const view = await mount(<AgendaConfigChange item={{ confirms }} />);
    expect(view.container.querySelector('[data-agenda-held-text-link]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-held-text]')?.textContent).toBe(
      'Read the held text in Settings › Configuration files.',
    );
    await view.unmount();
  });
});
