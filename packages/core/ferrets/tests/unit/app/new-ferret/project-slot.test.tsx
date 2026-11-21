import { describe, expect, it } from 'bun:test';
import { NEW_FERRET_PROJECT_SLOT, type NewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import type { ReactTestInstance, ReactTestRendererJSON } from 'react-test-renderer';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { run, runAsync, render } from '../support/react.ts';
import { scripted, type Call } from '../support/client.ts';

/** A stand-in for Projects' panel: one row per project, which proposes its folder through the slot's `onPick`. */
const stubProjects = (props: Record<string, unknown>): ReactNode => {
  const slot = props as unknown as NewFerretProjectSlotProps;
  return (
    <section data-new-ferret-projects="">
      <button data-row="p2" onClick={() => slot.onPick(FOLDER)} type="button">
        project two
      </button>
    </section>
  );
};

const FOLDER = '/work/p2 ';

const page = (calls: Call[] = []) =>
  render(
    <WithSlotPanels
      slots={{ [NEW_FERRET_PROJECT_SLOT]: [{ plugin: 'projects', id: 'new-ferret-projects', view: stubProjects }] }}
    >
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={scripted({ 'GET /v1/ferrets': [], 'POST /v1/ferrets': { id: 'new-ferret' } }, calls)}
        daemon="daemon/a"
        onNavigate={() => undefined}
      />
    </WithSlotPanels>,
  );

/** Every host element in draw order, depth first. */
const hostsOf = (node: ReactTestRendererJSON | ReactTestRendererJSON[] | null): ReactTestRendererJSON[] => {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap(hostsOf);
  return [node, ...(node.children ?? []).flatMap(child => (typeof child === 'string' ? [] : hostsOf(child)))];
};

describe('the New ferret page and the project slot', () => {
  it('draws the projects ABOVE the Folder box, and a pick fills that box', () => {
    const view = page();
    const hosts = hostsOf(view.toJSON());
    const slotAt = hosts.findIndex(host => host.props['data-new-ferret-projects'] !== undefined);
    const folderAt = hosts.findIndex(host => host.props.id === 'fy-new-ferret-folder');
    expect(slotAt).toBeGreaterThanOrEqual(0);
    expect(folderAt).toBeGreaterThan(slotAt);

    run(() => view.root.findByProps({ 'data-row': 'p2' }).props.onClick());
    const folder = view.root.findAll(node => typeof node.type === 'string' && node.props.id === 'fy-new-ferret-folder');
    expect(folder.at(0)?.props.value).toBe(FOLDER);
  });

  it('starts in the picked project exactly as registered: a trailing space is not trimmed into a sibling folder', async () => {
    const calls: Call[] = [];
    const view = page(calls);
    run(() => view.root.findByProps({ 'data-row': 'p2' }).props.onClick());
    const found = (predicate: (node: ReactTestInstance) => boolean): ReactTestInstance => {
      const node = view.root.findAll(predicate).at(0);
      if (node === undefined) throw new Error('missing element');
      return node;
    };
    const typeInto = (id: string, value: string): void =>
      run(() =>
        found(node => typeof node.type === 'string' && node.props.id === id).props.onChange({ target: { value } }),
      );
    typeInto('fy-new-ferret-runtime', 'claude-auto-loge');
    typeInto('fy-new-ferret-prompt', 'Go');
    const create = found(node => node.type === 'button' && node.children.join('') === 'Create ferret');
    await runAsync(async () => create.props.onClick());
    expect(calls.find(call => call.route === 'POST /v1/ferrets')?.body).toMatchObject({ folder: FOLDER });
  });
});
