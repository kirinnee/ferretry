import { describe, expect, test } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import { FilesSearchPanel } from '../../../../app/slots/files-search-panel.tsx';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

const INDEX = 'GET /v1/ferrets/:ferretId/fs/index';

/** The props a slot hands a panel: the shell spreads them beside `subject`. */
const slot = (props: object): PanelProps => props as PanelProps;

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

const index = (call: { readonly params: Readonly<Record<string, string>> }) => ({
  v: 1,
  sessionId: call.params['ferretId'],
  root: '/work/f1',
  files: [{ name: 'needle.ts', path: 'src/needle.ts' }],
  coverage: 'complete',
  skipped: [],
});

describe('the current-ferret file search in the file browser', () => {
  test('searches this ferret’s files and opens the one picked in the browser', async () => {
    const opened: string[] = [];
    const client = fakeClient({ [INDEX]: index }, 'alpha');
    const view = render(
      withClient(
        client,
        <FilesSearchPanel {...slot({ ferret: 'f1', openFile: (path: string) => opened.push(path) })} />,
      ),
    );
    await settle();
    run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
    await settle();
    const rows = view.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
    run(() => rows[0]?.props.onClick());
    expect(opened).toEqual(['src/needle.ts']);
    expect(client.callsTo(INDEX)[0]?.params).toEqual({ ferretId: 'f1' });
    run(() => view.unmount());
  });

  test('draws nothing when the slot hands something else, or the daemon is not known', async () => {
    const stray = fakeClient({}, 'alpha');
    const other = render(withClient(stray, <FilesSearchPanel />));
    expect(other.toJSON()).toBeNull();
    run(() => other.unmount());

    const unnamed = fakeClient({});
    const nameless = render(
      withClient(unnamed, <FilesSearchPanel {...slot({ ferret: 'f1', openFile: () => undefined })} />),
    );
    expect(nameless.toJSON()).toBeNull();
    expect(unnamed.calls).toEqual([]);
    run(() => nameless.unmount());
  });

  test('a card result needs a board, and this panel has none: it holds files only', async () => {
    const client = fakeClient({ [INDEX]: index }, 'alpha');
    const view = render(
      withClient(client, <FilesSearchPanel {...slot({ ferret: 'f1', openFile: () => undefined })} />),
    );
    await settle();
    run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
    await settle();
    const kinds = view.root.findAll(node => node.props['data-result-kind'] !== undefined);
    expect(kinds.map(node => node.props['data-result-kind'])).toEqual(['file']);
    run(() => view.unmount());
  });
});
