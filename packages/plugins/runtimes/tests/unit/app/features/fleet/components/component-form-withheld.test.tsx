import { describe, expect, it } from 'bun:test';
import { ComponentForm } from '../../../../../../app/features/fleet/components/component-form.tsx';
import {
  blankDraft,
  componentChange,
  draftFromComponent,
  draftProblem,
  mcpCommandLine,
  WITHHELD_ARGS_PROBLEM,
  WITHHELD_COMMAND_PROBLEM,
  WITHHELD_FLAGS_PROBLEM,
} from '../../../../../../app/features/fleet/components/component-model.ts';
import { mount, must } from '../../../../support/dom.ts';
import { component } from './catalog-fixture.ts';

const noop = (): void => undefined;

const withheldServer = (detail: Record<string, unknown>) =>
  component({
    reference: 'mcp/srv',
    kind: 'mcp',
    name: 'srv',
    detail: { kind: 'mcp', env: [], ...detail } as never,
  });

describe('Component form: a withheld MCP command or address', () => {
  it('reads as an empty line with the sentence, never blank or "undefined", and keeps nothing by position', () => {
    for (const detail of [{ commandWithheld: true, args: ['-y', 'pkg'], argsEtag: 'etag' }, { urlWithheld: true }]) {
      const view = withheldServer(detail);
      const draft = draftFromComponent(view);
      expect(draft).toMatchObject({ body: '', commandWithheld: true, hiddenArgs: [] });
      expect(draft.wordsEtag).toBeUndefined();
      expect(mcpCommandLine(view.detail as never)).toBe('');
      expect(draftProblem(draft, [view], 'srv')).toBe(WITHHELD_COMMAND_PROBLEM);
      expect(WITHHELD_COMMAND_PROBLEM).not.toContain('undefined');
    }
  });

  it('retyping the whole line saves it as a whole-value replace, with no kept word', () => {
    const view = withheldServer({ commandWithheld: true });
    const typed = { ...draftFromComponent(view), body: 'npx -y @scope/server' };
    expect(draftProblem(typed, [view], 'srv')).toBeUndefined();
    const change = componentChange(typed, false);
    expect(JSON.stringify(change)).toContain('"command":"npx"');
    expect(JSON.stringify(change)).not.toContain('argsEtag');
    expect(JSON.stringify(change)).not.toContain('keep');
  });

  it('renders the sentence in the form', async () => {
    const view = await mount(
      <ComponentForm draft={{ ...blankDraft('mcp'), name: 'srv', commandWithheld: true }} onChange={noop} editing />,
    );
    const line = must(view.container.querySelector('[data-component-withheld]'), 'withheld line');
    expect(line.textContent).toBe(WITHHELD_COMMAND_PROBLEM);
    await view.unmount();
  });
});

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
