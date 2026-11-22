import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import {
  addressOpenRequest,
  fileOfAddress,
  markAddressHandled,
  resetAddressOpens,
} from '../../../../app/features/files/address-file.ts';
import { resetFsProbes } from '../../../../app/features/files/files-api.ts';
import { resetFilesTabStates } from '../../../../app/features/files/files-tab-model.ts';
import { createFilesPanel } from '../../../../app/views/files.tsx';
import { interact, mount } from '../support/dom.ts';
import { type FsCall, type FsFixture, fsClient } from './support/fs-client.ts';

const ADDRESS = '/d/work/ferrets/zed';
const originalAddress = `${window.location.pathname}${window.location.search}`;

beforeEach(() => {
  resetAddressOpens();
  resetFilesTabStates();
  resetFsProbes();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1_280 });
});

afterEach(() => {
  window.history.replaceState({}, '', originalAddress);
});

describe('fileOfAddress', () => {
  it('is the folder-relative path the address names', () => {
    expect(fileOfAddress('?file=src%2Fentry.ts')).toBe('src/entry.ts');
    expect(fileOfAddress('?file=.%2Fsrc%2Fentry-ts')).toBe('src/entry-ts');
  });

  it('is nothing for no file, an absolute path, a climb, a backslash or a control character', () => {
    for (const search of [
      '',
      '?file=',
      '?find=a',
      '?file=%2Fetc%2Fpasswd',
      '?file=..%2Fx',
      '?file=a%5Cb',
      '?file=a%00b',
    ])
      expect(fileOfAddress(search)).toBeNull();
  });
});

describe('addressOpenRequest', () => {
  it('is asked once per address, below any request a panel makes', () => {
    const asked = addressOpenRequest(ADDRESS, '?file=a.ts');
    expect(asked).toEqual({ sequence: 0, reference: { path: 'a.ts' } });
    expect(addressOpenRequest(ADDRESS, '?file=a.ts')).toEqual(asked);
    markAddressHandled(ADDRESS, '?file=a.ts');
    expect(addressOpenRequest(ADDRESS, '?file=a.ts')).toBeNull();
    expect(addressOpenRequest(ADDRESS, '?file=b.ts')?.reference.path).toBe('b.ts');
  });
});

describe('the Files panel', () => {
  it('opens the file an address names, through its own read, once', async () => {
    window.history.replaceState({}, '', `${ADDRESS}?file=src%2Fentry-ts`);
    const calls: FsCall[] = [];
    const fixture: FsFixture = {
      files: { 'src/entry-ts': { path: 'src/entry-ts', content: 'export const entry = 1;' } },
    };
    const Panel = createFilesPanel(fsClient(() => fixture, calls)) as ComponentType<PanelProps>;
    const view = await mount(<Panel subject="zed" />);
    await interact(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    try {
      expect(calls.filter(call => call.route.endsWith('/fs/file')).map(call => call.query.path)).toEqual([
        'src/entry-ts',
      ]);
      expect(view.container.textContent).toContain('export const entry = 1;');
    } finally {
      await view.unmount();
    }
  });

  it('opens nothing for an address with no file, or one that climbs out of the folder', async () => {
    for (const search of ['', '?file=..%2Fsecret']) {
      window.history.replaceState({}, '', `${ADDRESS}${search}`);
      const calls: FsCall[] = [];
      const Panel = createFilesPanel(fsClient(() => ({}), calls)) as ComponentType<PanelProps>;
      const view = await mount(<Panel subject="zed" />);
      await interact(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      });
      try {
        expect(calls.filter(call => call.route.endsWith('/fs/file'))).toEqual([]);
      } finally {
        await view.unmount();
      }
    }
  });
});
