import { beforeEach, describe, expect, it } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { resetFsProbes } from '../../../../app/features/files/files-api.ts';
import { readFilesTabState, resetFilesTabStates } from '../../../../app/features/files/files-tab-model.ts';
import { FilesTab } from '../../../../app/features/files/files-tab.tsx';
import { FileBody } from '../../../../app/features/files/files-views.tsx';
import { createFilesPanel } from '../../../../app/views/files.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { type FsCall, type FsFixture, fsClient, scopeOf } from './support/fs-client.ts';

/**
 * The daemon masks secret values in everything these routes answer (the manifest's \`guard: 'secrets'\`): the viewer's
 * part of that guarantee is to draw exactly what it was told, never to restore, reveal, copy or remember the masked
 * value, and never to put file text anywhere but the screen. A masked placeholder is the only form a secret ever has
 * in this page, so these tests use one and prove it is never replaced, offered a way around, or leaked sideways.
 */
const MASKED = 'token = [secret:DEPLOY_KEY]';
const REAL_LOOKING = 'sk-live-should-never-appear';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

let fixture: FsFixture;
let calls: FsCall[];
let scope: ReturnType<typeof scopeOf>;

beforeEach(() => {
  fixture = {
    listings: { '': { entries: [{ name: 'config.env.example', type: 'file', size: MASKED.length }] } },
    files: { 'config.env.example': { path: 'config.env.example', content: MASKED } },
    diffs: { 'config.env.example': `diff --git a/c b/c\n@@ -1 +1 @@\n-old = [secret:DEPLOY_KEY]\n+${MASKED}` },
    changes: { repo: true, changes: [{ path: 'config.env.example', status: ' M' }] },
  };
  calls = [];
  scope = scopeOf(
    fsClient(() => fixture, calls),
    'work',
  );
  resetFilesTabStates();
  resetFsProbes();
});

const openFile = async () => {
  const view = await mount(<FilesTab scope={scope} />);
  await settle();
  await interact(() =>
    must(
      view.container.querySelector<HTMLElement>('[aria-label^="Open file config.env.example"]'),
      'the file row',
    ).click(),
  );
  await settle();
  return view;
};

describe('the files tab and secrets', () => {
  it('S47 a masked placeholder in a file answer stays the placeholder in the page, as text', async () => {
    const view = await openFile();
    try {
      expect(view.container.textContent).toContain(MASKED);
      expect(view.container.textContent).not.toContain(REAL_LOOKING);
      // As escaped text in a block, not as markup: the placeholder's brackets are not interpreted.
      expect(must(view.container.querySelector('pre'), 'the file text').textContent).toBe(MASKED);
    } finally {
      await view.unmount();
    }
  });

  it('S47 a masked placeholder in a diff stays the placeholder, on both sides of a change', async () => {
    const view = await openFile();
    try {
      await interact(() =>
        must(
          view.container.querySelector<HTMLElement>('[aria-label="Show git diff for config.env.example"]'),
          'the diff action',
        ).click(),
      );
      await settle();
      const text = view.container.textContent ?? '';
      expect(text).toContain('old = [secret:DEPLOY_KEY]');
      expect(text).toContain(MASKED);
      expect(text).not.toContain(REAL_LOOKING);
    } finally {
      await view.unmount();
    }
  });

  it('S47 offers no reveal, unmask, show-value or copy control on a file, in any of its views', async () => {
    const view = await openFile();
    try {
      const names = () =>
        [...view.container.querySelectorAll('button, a')].map(
          node =>
            `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''} ${node.textContent ?? ''}`,
        );
      for (const label of names()) expect(label).not.toMatch(/reveal|unmask|show (the )?(secret|value)|copy/iu);
      await interact(() =>
        must(view.container.querySelector<HTMLElement>('[aria-label^="Show raw bytes"]'), 'the raw action').click(),
      );
      await settle();
      for (const label of names()) expect(label).not.toMatch(/reveal|unmask|show (the )?(secret|value)|copy/iu);
      // Raw is the same answer drawn as text: the masked value, not another read for the real one.
      expect(must(view.container.querySelector('pre'), 'the raw text').textContent).toBe(MASKED);
    } finally {
      await view.unmount();
    }
  });

  it('S47 reads a file with exactly one request on the guarded file route, and Raw asks for nothing more', async () => {
    const view = await openFile();
    try {
      const fileReads = () => calls.filter(call => call.route.endsWith('/fs/file'));
      expect(fileReads()).toHaveLength(1);
      // No other way to the bytes: a plain read names the path alone, never the committed copy or the media folder.
      expect(fileReads()[0]?.query).toEqual({ path: 'config.env.example' });
      await interact(() =>
        must(view.container.querySelector<HTMLElement>('[aria-label^="Show raw bytes"]'), 'the raw action').click(),
      );
      await settle();
      expect(fileReads()).toHaveLength(1);
      expect(calls.every(call => call.route.startsWith('GET /v1/ferrets/:ferretId/fs'))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('S47 puts no file text in a URL, a title, an aria-label or any attribute', async () => {
    const view = await openFile();
    try {
      for (const element of view.container.querySelectorAll('*'))
        for (const attribute of element.getAttributeNames()) {
          const value = element.getAttribute(attribute) ?? '';
          expect(value).not.toContain('DEPLOY_KEY');
          expect(value).not.toContain('token =');
        }
      expect(calls.every(call => Object.values(call.query).every(value => !value.includes('DEPLOY_KEY')))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('S47 remembers only paths and views of open files, never their text', async () => {
    const view = await openFile();
    try {
      const remembered = JSON.stringify(readFilesTabState(scope));
      expect(remembered).toContain('config.env.example');
      expect(remembered).not.toContain('DEPLOY_KEY');
      expect(remembered).not.toContain('token');
    } finally {
      await view.unmount();
    }
  });

  it('S47 draws a file the daemon refused as the refusal, with no content and no way around it', async () => {
    fixture.files = {
      'config.env.example': { path: 'config.env.example', denied: true, reason: 'denylist', rule: '*.env*' },
    };
    const view = await openFile();
    try {
      expect(view.container.textContent).toContain('denylist and is never served');
      expect(view.container.textContent).not.toContain(MASKED);
      expect(view.container.querySelector('pre')).toBeNull();
      expect(view.container.querySelector('[aria-label*="anyway" i], [aria-label*="force" i]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('S47 draws a masked value inside a file body as inert text, never as markup', async () => {
    const view = await mount(
      <FileBody file={{ path: 'a.txt', size: 3, content: '<script>alert(1)</script> [secret:X]' }} path="a.txt" />,
    );
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.textContent).toContain('<script>alert(1)</script> [secret:X]');
    await view.unmount();
  });
});

describe('the files panel', () => {
  it('draws a note, and reads nothing, until the shell names a ferret', async () => {
    const Panel = createFilesPanel(fsClient(() => fixture, calls)) as ComponentType<PanelProps>;
    const view = await mount(<Panel />);
    await settle();
    expect(view.container.textContent).toContain('Pick a ferret to browse its files.');
    expect(calls).toHaveLength(0);
    await view.unmount();
  });

  it('browses the ferret the shell names, through the half’s client', async () => {
    const Panel = createFilesPanel(fsClient(() => fixture, calls)) as ComponentType<PanelProps>;
    const view = await mount(<Panel subject="ferret-7" />);
    await settle();
    expect(view.container.textContent).toContain('config.env.example');
    expect(calls.every(call => call.ferretId === 'ferret-7')).toBe(true);
    await view.unmount();
  });

  it('S47 a redacted file says private values are masked and that this is not the file', async () => {
    fixture.files = { 'config.env.example': { path: 'config.env.example', content: MASKED, redacted: true } };
    const view = await openFile();
    try {
      expect(view.container.textContent).toContain('private values masked — this is not the file');
    } finally {
      await view.unmount();
    }
  });

  it('S47 a file that is not redacted shows no masked notice', async () => {
    const view = await openFile();
    try {
      expect(view.container.textContent).not.toContain('private values masked');
    } finally {
      await view.unmount();
    }
  });
});
