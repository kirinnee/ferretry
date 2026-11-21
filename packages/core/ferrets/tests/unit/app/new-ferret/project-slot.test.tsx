import { describe, expect, it } from 'bun:test';
import { NEW_FERRET_PROJECT_SLOT, type NewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { run, render } from '../support/react.ts';
import { scripted } from '../support/client.ts';

/** A stand-in for Projects' panel: one row per project, which proposes its folder through the slot's `onPick`. */
const stubProjects = (props: Record<string, unknown>): ReactNode => {
  const slot = props as unknown as NewFerretProjectSlotProps;
  return (
    <section data-new-ferret-projects="">
      <button data-row="p2" onClick={() => slot.onPick('/work/p2')} type="button">
        project two
      </button>
    </section>
  );
};

const page = () =>
  render(
    <WithSlotPanels
      slots={{ [NEW_FERRET_PROJECT_SLOT]: [{ plugin: 'projects', id: 'new-ferret-projects', view: stubProjects }] }}
    >
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={scripted({ 'GET /v1/ferrets': [] })}
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
    expect(folder.at(0)?.props.value).toBe('/work/p2');
  });
});
