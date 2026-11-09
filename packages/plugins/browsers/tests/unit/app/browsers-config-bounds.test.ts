import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE } from '@ferretry/std/yaml';
import { type BrowsersDocument, readBrowsersConfig, writeBrowsersConfig } from '../../../app/lib/browsers-config.ts';
import type { CallClient } from '../../../app/lib/clients.ts';
import { BrowsersConfigSchema } from '../../../contract/index.ts';

// The settings tab runs in the person's own browser on the `browsers.yaml` text the daemon serves, and the daemon
// serves a file the kernel itself refused. The tab reads and edits it through the shared bounded reader
// (`@ferretry/std/yaml`), so a planted file is refused in one fixed sentence instead of stalling the tab. One hostile
// text of each shape, through THIS plugin's own entry points (`readBrowsersConfig`, `writeBrowsersConfig`).

const FAST_MS = 2000;

/** A nest of anchors, each aliasing the previous ten times: a million nodes from six short lines. */
const laughs = (): string => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  return names
    .map((name, index) => {
      const previous = names[index - 1];
      const items = previous === undefined ? 'x' : `*${previous}`;
      return `${name}: &${name} [${Array.from({ length: 10 }, () => items).join(', ')}]`;
    })
    .join('\n');
};

/**
 * `editsRefused`: whether an EDIT of the text is refused here too. An edit never expands an alias (it rewrites one key and
 * prints the document back), so the two alias shapes are handed on unexpanded and the daemon's own check refuses them.
 */
const HOSTILE: Readonly<
  Record<string, { readonly text: () => string; readonly sentence: string; readonly editsRefused: boolean }>
> = {
  'a text over the size cap': {
    text: () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1),
    sentence: CONFIG_TOO_LARGE,
    editsRefused: true,
  },
  'an alias bomb (nested anchors)': {
    text: laughs,
    sentence: 'the aliases (*name) in this file expand too far to read',
    editsRefused: false,
  },
  'a 128 KiB string aliased 18 000 times': {
    text: () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
    sentence: 'the aliases (*name) in this file expand too far to read',
    editsRefused: false,
  },
  'a flood of % directive lines': {
    text: () => '%\n'.repeat(131_072),
    sentence: 'a % directive line is not one YAML knows',
    editsRefused: true,
  },
};

/** The one client the tab is handed: `GET /v1/config/file` answers `text`, `PUT /v1/config/file` is recorded and held. */
const serving = (text: string): { readonly client: CallClient; readonly calls: string[] } => {
  const calls: string[] = [];
  const client = {
    call: async (key: string) => {
      calls.push(key);
      if (key === 'GET /v1/config/file') return { path: 'browsers.yaml', exists: true, text, etag: 'e1' };
      if (key === 'PUT /v1/config/file') return { path: 'browsers.yaml', etag: 'e2', outcome: 'pending' };
      throw new Error(`unexpected ${key}`);
    },
  } as unknown as CallClient;
  return { client, calls };
};

describe('browsers: the settings tab refuses a hostile browsers.yaml in one fixed sentence, promptly', () => {
  for (const [shape, { text, sentence, editsRefused }] of Object.entries(HOSTILE)) {
    test(`browsers readBrowsersConfig, ${shape}`, async () => {
      const { client } = serving(text());
      const started = performance.now();
      const read = readBrowsersConfig(client);
      await expect(read).rejects.toThrow(`browsers.yaml does not parse: ${sentence}`);
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });

    test(`browsers writeBrowsersConfig, ${shape}`, async () => {
      const { client, calls } = serving('');
      const current: BrowsersDocument = { config: BrowsersConfigSchema.parse({}), text: text(), etag: 'e1' };
      const started = performance.now();
      const write = writeBrowsersConfig(client, current, { mode: 'window' });
      if (editsRefused) {
        await expect(write).rejects.toThrow(`the file does not parse: ${sentence}`);
        // Nothing was sent: a file nobody can read is fixed by a person, not overwritten by a verb.
        expect(calls).toEqual([]);
      } else {
        await expect(write).resolves.toBe('pending');
        expect(calls).toEqual(['PUT /v1/config/file']);
      }
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });
  }
});
