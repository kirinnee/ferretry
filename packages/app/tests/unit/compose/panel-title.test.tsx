/**
 * The Settings shell owns the panel's one heading: a SettingGroup named for the tab it sits in draws no second heading
 * (it keeps its name for assistive tech), and one named otherwise keeps its own.
 */

import { describe, expect, it } from 'bun:test';
import { PanelTitleContext } from '../../../src/compose/panel-title.ts';
import { SettingGroup } from '../../../src/compose/setting-row.tsx';
import { mount } from '@ferretry/app/testing';

describe('SettingGroup under a Settings panel title', () => {
  it('draws no heading when its label is the panel title, and says its name by aria-label', async () => {
    const view = await mount(
      <PanelTitleContext.Provider value="Codex">
        <SettingGroup label="codex">{null}</SettingGroup>
      </PanelTitleContext.Provider>,
    );
    expect(view.container.querySelector('h3')).toBeNull();
    const section = view.container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe('codex');
    expect(section?.getAttribute('aria-labelledby')).toBeNull();
    await view.unmount();
  });

  it('keeps its heading when its label is not the panel title, or when there is no panel', async () => {
    const other = await mount(
      <PanelTitleContext.Provider value="Codex">
        <SettingGroup label="Update">{null}</SettingGroup>
      </PanelTitleContext.Provider>,
    );
    expect(other.container.querySelector('h3')?.textContent).toBe('Update');
    await other.unmount();
    const bare = await mount(<SettingGroup label="Codex">{null}</SettingGroup>);
    expect(bare.container.querySelector('h3')?.textContent).toBe('Codex');
    await bare.unmount();
  });
});
