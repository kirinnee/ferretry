import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  RichFilePreview,
  bytesFromBase64,
  parsePreviewCsv,
  richFileKind,
  richFileMime,
} from '../../src/components/rich-file-preview.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'preview-daemon',
  baseUrl: 'https://preview.example.test',
  deviceToken: 'preview-token',
});
const scope = daemonSessionScope(daemon, 'session');
const originalFetch = globalThis.fetch;
let previewPayload: Record<string, string>;
let previewFailure: Error | null;
const previewFetch: DaemonFetch = async () => {
  if (previewFailure) throw previewFailure;
  return Response.json(previewPayload);
};

beforeEach(() => {
  previewPayload = { path: 'report.html', base64: 'PGgxPnVudHJ1c3RlZDwvaDE+' };
  previewFailure = null;
  globalThis.fetch = previewFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('rich file preview classification', () => {
  it('recognises only the bounded preview formats', () => {
    expect(richFileKind('report.HTML')).toBe('html');
    expect(richFileKind('report.htm')).toBe('html');
    expect(richFileKind('report.pdf')).toBe('pdf');
    expect(richFileKind('photo.webp')).toBe('raster');
    expect(richFileKind('diagram.svg')).toBe('svg');
    expect(richFileKind('table.csv')).toBe('csv');
    expect(richFileKind('secret.env')).toBeNull();
  });

  it('uses a document type for every object URL', () => {
    expect(richFileMime('report.htm', 'html')).toBe('text/html;charset=utf-8');
    expect(richFileMime('photo.jpeg', 'raster')).toBe('image/jpeg');
    expect(richFileMime('diagram.svg', 'svg')).toBe('image/svg+xml');
  });

  it('decodes fetched bytes instead of putting a daemon credential in a document URL', () => {
    expect(bytesFromBase64('AAH/')).toEqual(new Uint8Array([0, 1, 255]));
  });
});

describe('bounded CSV preview parsing', () => {
  it('keeps quoted commas and newlines in one escaped cell', () => {
    expect(parsePreviewCsv('name,note\nAda,"one, two\nand three"')).toEqual({
      rows: [
        ['name', 'note'],
        ['Ada', 'one, two\nand three'],
      ],
      truncated: false,
      malformed: false,
    });
  });

  it('caps generated tables rather than allocating an unbounded grid', () => {
    const rows = Array.from({ length: 401 }, (_, index) => `row-${index}`).join('\n');
    const parsed = parsePreviewCsv(rows);
    expect(parsed.rows).toHaveLength(400);
    expect(parsed.truncated).toBe(true);
    expect(parsed.malformed).toBe(false);
  });

  it('marks an unclosed quoted cell as malformed instead of inventing a table', () => {
    expect(parsePreviewCsv('name,note\nAda,"unfinished')).toMatchObject({
      rows: [
        ['name', 'note'],
        ['Ada', 'unfinished'],
      ],
      malformed: true,
    });
  });
});

describe('rich preview containment', () => {
  it('puts untrusted HTML in a zero-permission sandbox and keeps the daemon credential out of its URL', async () => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (() => {
      const url = `blob:preview/${created.length + 1}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
    try {
      const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="report.html" revision={1} />);
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      const frame = must(view.container.querySelector('iframe'), 'sandboxed HTML frame');
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('src')).toBe('blob:preview/1');
      expect(frame.getAttribute('src')).not.toContain(daemon.deviceToken);
      await view.unmount();
      expect(revoked).toEqual(['blob:preview/1']);
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  it('names a CSV that exceeds the table bound', async () => {
    previewPayload = { path: 'large.csv', base64: btoa('x'.repeat(512 * 1024 + 1)) };
    const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="large.csv" revision={1} />);
    try {
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      expect(view.container.textContent).toContain('CSV table previews stop at 512 KB');
    } finally {
      await view.unmount();
    }
  });

  it('names an unavailable preview read instead of showing an empty document', async () => {
    previewFailure = new TypeError('offline');
    const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="report.html" revision={1} />);
    try {
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      expect(must(view.container.querySelector('[role="alert"]'), 'unavailable preview alert').textContent).toContain(
        'Could not load a safe preview: could not reach the daemon',
      );
    } finally {
      await view.unmount();
    }
  });
});
