import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  bytesFromBase64,
  parsePreviewCsv,
  RichFilePreview,
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
/**
 * Patching the global is deliberate: the component reaches the network through `browserFetch`, which
 * calls `globalThis.fetch`, so this exercises the real binding rather than an injected seam that
 * cannot reproduce a receiver bug. `preconnect` is carried over from the real builtin instead of
 * being cast away — the runtime's `fetch` genuinely has it, and a cast would only hide that.
 */
const previewFetch: typeof fetch = Object.assign(
  (async () => {
    if (previewFailure) throw previewFailure;
    return Response.json(previewPayload);
  }) satisfies DaemonFetch,
  { preconnect: originalFetch.preconnect },
);

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
    expect(richFileMime('report.pdf', 'pdf')).toBe('application/pdf');
    expect(richFileMime('photo.jpeg', 'raster')).toBe('image/jpeg');
    expect(richFileMime('photo.png', 'raster')).toBe('image/png');
    expect(richFileMime('photo.gif', 'raster')).toBe('image/gif');
    expect(richFileMime('photo.webp', 'raster')).toBe('image/webp');
    expect(richFileMime('photo.avif', 'raster')).toBe('image/avif');
    expect(richFileMime('photo.unknown', 'raster')).toBe('application/octet-stream');
    expect(richFileMime('diagram.svg', 'svg')).toBe('image/svg+xml');
    expect(richFileMime('table.csv', 'csv')).toBe('text/csv;charset=utf-8');
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

  it('unescapes a quoted quote without splitting the field', () => {
    expect(parsePreviewCsv('note\n"say ""hello"""')).toEqual({
      rows: [['note'], ['say "hello"']],
      truncated: false,
      malformed: false,
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

  it('names malformed base64 as unavailable bytes instead of interpreting it as an empty preview', async () => {
    previewPayload = { path: 'report.html', base64: 'not base64!' };
    const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="report.html" revision={1} />);
    try {
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      expect(view.container.textContent).toContain('Preview bytes are unavailable');
    } finally {
      await view.unmount();
    }
  });

  it('renders a bounded CSV grid and names its rendered cap', async () => {
    const csv = Array.from({ length: 401 }, (_, index) => `row-${index},value-${index}`).join('\n');
    previewPayload = { path: 'table.csv', base64: btoa(csv) };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:preview/csv') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="table.csv" revision={1} />);
      try {
        await interact(async () => {
          for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        expect(must(view.container.querySelector('table'), 'CSV table')).toBeDefined();
        expect(must(view.container.querySelector('th'), 'CSV header').textContent).toBe('row-0');
        expect(must(view.container.querySelector('td'), 'CSV value').textContent).toBe('row-1');
        expect(view.container.textContent).toContain('Table preview is capped at 400 rows');
        expect(
          must(view.container.querySelector('a[download="table.csv"]'), 'CSV download').hasAttribute('target'),
        ).toBe(false);
      } finally {
        await view.unmount();
      }
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  it('renders a PDF in the same zero-permission frame, never an authenticated document URL', async () => {
    previewPayload = { path: 'report.pdf', base64: 'JVBERg==' };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:preview/pdf') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="report.pdf" revision={1} />);
      try {
        await interact(async () => {
          for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        const frame = must(view.container.querySelector('iframe'), 'PDF frame');
        expect(frame.getAttribute('sandbox')).toBe('');
        expect(frame.getAttribute('src')).toBe('blob:preview/pdf');
        expect(frame.getAttribute('src')).not.toContain(daemon.deviceToken);
        expect(frame.getAttribute('title')).toBe('PDF preview of report.pdf');
        expect(
          must(view.container.querySelector('a[target="_blank"]'), 'safe PDF open link').getAttribute('href'),
        ).toBe('blob:preview/pdf');
      } finally {
        await view.unmount();
      }
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  it('renders raster bytes as an image, never as an executable SVG-like document', async () => {
    previewPayload = { path: 'photo.png', base64: 'iVBORw==' };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:preview/image') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="photo.png" revision={1} />);
      try {
        await interact(async () => {
          for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        const image = must(view.container.querySelector('img'), 'raster preview');
        expect(image.getAttribute('src')).toBe('blob:preview/image');
        expect(image.getAttribute('alt')).toBe('Preview of photo.png');
        expect(view.container.querySelector('iframe')).toBeNull();
      } finally {
        await view.unmount();
      }
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  /**
   * What is asserted here is the APP's decision, not a decoder's: bytes that
   * are not a valid document still reach the same containment — SVG through an
   * image element, PDF through the zero-permission frame — and rendering them
   * throws nothing into React. Whether the browser then draws a broken-image
   * glyph or a viewer error is the browser's business, and happy-dom has no
   * honest answer for it, so nothing here claims one.
   */
  it('routes corrupt SVG and PDF bytes through the same containment, never into the app DOM', async () => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:preview/corrupt') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      previewPayload = { path: 'broken.svg', base64: btoa('<svg><script>truncated') };
      const svg = await mount(<RichFilePreview daemon={daemon} scope={scope} path="broken.svg" revision={1} />);
      try {
        await interact(async () => {
          for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        const image = must(svg.container.querySelector('img'), 'corrupt SVG preview');
        expect(image.getAttribute('src')).toBe('blob:preview/corrupt');
        // Never parsed as a document, so the markup inside cannot execute.
        // (`svg` itself is not a useful probe here — the action icons are SVG.)
        expect(svg.container.querySelector('script')).toBeNull();
        expect(svg.container.querySelector('iframe')).toBeNull();
      } finally {
        await svg.unmount();
      }

      previewPayload = { path: 'broken.pdf', base64: btoa('%PDF-1.7 truncated') };
      const pdf = await mount(<RichFilePreview daemon={daemon} scope={scope} path="broken.pdf" revision={1} />);
      try {
        await interact(async () => {
          for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        const frame = must(pdf.container.querySelector('iframe'), 'corrupt PDF frame');
        expect(frame.getAttribute('sandbox')).toBe('');
        expect(frame.getAttribute('src')).toBe('blob:preview/corrupt');
      } finally {
        await pdf.unmount();
      }
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  it('renders a malformed CSV as an explicit refusal instead of an invented grid', async () => {
    previewPayload = { path: 'broken.csv', base64: btoa('name,note\nAda,"unfinished') };
    const view = await mount(<RichFilePreview daemon={daemon} scope={scope} path="broken.csv" revision={1} />);
    try {
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      expect(view.container.textContent).toContain('This CSV has an unclosed quoted cell');
      expect(view.container.querySelector('table')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
