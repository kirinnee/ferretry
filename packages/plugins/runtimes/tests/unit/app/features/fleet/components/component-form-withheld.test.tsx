import { describe, expect, it } from 'bun:test';
import { ComponentForm } from '../../../../../../app/features/fleet/components/component-form.tsx';
import {
  blankDraft,
  WITHHELD_ARGS_PROBLEM,
  WITHHELD_FLAGS_PROBLEM,
} from '../../../../../../app/features/fleet/components/component-model.ts';
import { mount, must } from '../../../../support/dom.ts';

const noop = (): void => undefined;

describe('Component form: withheld words', () => {
  it('says in plain words that an MCP server’s arguments are withheld', async () => {
    const view = await mount(
      <ComponentForm draft={{ ...blankDraft('mcp'), name: 'srv', wordsWithheld: true }} onChange={noop} editing />,
    );
    const line = must(view.container.querySelector('[data-component-withheld]'), 'withheld line');
    expect(line.textContent).toBe(WITHHELD_ARGS_PROBLEM);
    await view.unmount();
  });

  it('says it for withheld settings flags, and says nothing when nothing is withheld', async () => {
    const withheld = await mount(
      <ComponentForm draft={{ ...blankDraft('settings'), name: 's', wordsWithheld: true }} onChange={noop} editing />,
    );
    expect(withheld.container.querySelector('[data-component-withheld]')?.textContent).toBe(WITHHELD_FLAGS_PROBLEM);
    await withheld.unmount();

    const shown = await mount(<ComponentForm draft={{ ...blankDraft('mcp'), name: 'srv' }} onChange={noop} editing />);
    expect(shown.container.querySelector('[data-component-withheld]')).toBeNull();
    await shown.unmount();
  });
});
