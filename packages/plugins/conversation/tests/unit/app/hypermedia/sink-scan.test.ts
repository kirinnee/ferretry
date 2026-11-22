/**
 * r12 H4 review R1 — S2: the sink scan that guards Durian's source must not be vacuous. The first one resolved the
 * metafile's paths from the wrong directory, turned every read error into clean text, and opened 0 of 42 files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForHtmlSinks } from '../../../integration/app/support/sink-scan.ts';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferretry-sink-scan-'));
  await mkdir(join(root, 'build/src'), { recursive: true });
});
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const scan = async (files: Readonly<Record<string, string>>, cwd = join(root, 'build')) => {
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'build', name), text);
  return scanForHtmlSinks(Object.keys(files), cwd);
};

describe('the sink scan reads what the metafile names, from the directory the build ran in', () => {
  it('opens every file and counts it (paths are relative to the build cwd)', async () => {
    const result = await scan({ 'src/a.ts': 'export const a = 1;', 'src/b.tsx': 'export const b = <p>hi</p>;' });
    expect(result).toEqual({ scanned: 2, hits: [] });
  });

  it('REJECTS when a file cannot be read, instead of reading it as clean text (the old path resolved 3 levels too high)', async () => {
    await writeFile(join(root, 'build/src/real.ts'), 'el.innerHTML = x;');
    // The same metafile path, resolved from a directory the build did not run in: nothing is there.
    await expect(scanForHtmlSinks(['src/real.ts'], join(root, 'build/src/nowhere'))).rejects.toThrow();
  });

  it('REJECTS a file it cannot parse, and one it has no loader for', async () => {
    await writeFile(join(root, 'build/src/broken.ts'), 'const = = (;');
    await expect(scanForHtmlSinks(['src/broken.ts'], join(root, 'build'))).rejects.toThrow();
    await writeFile(join(root, 'build/src/x.wasm'), '');
    await expect(scanForHtmlSinks(['src/x.wasm'], join(root, 'build'))).rejects.toThrow();
  });
});

describe('the sink scan finds every spelling of an HTML-string sink', () => {
  const SINKS: Readonly<Record<string, string>> = {
    'innerHTML =': 'el.innerHTML = html;',
    'innerHTML +=': 'el.innerHTML += html;',
    'outerHTML =': 'el.outerHTML = html;',
    'bracket spelling': "el['innerHTML'] = html;",
    insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', html);",
    createContextualFragment: 'range.createContextualFragment(html);',
    setHTMLUnsafe: 'el.setHTMLUnsafe(html);',
    parseHTMLUnsafe: 'Document.parseHTMLUnsafe(html);',
    DOMParser: "new DOMParser().parseFromString(html, 'text/html');",
    'document.write': 'document.write(html);',
    'document.writeln': 'document . writeln(html);',
    srcdoc: 'frame.srcdoc = html;',
    dangerouslySetInnerHTML: 'const p = <div dangerouslySetInnerHTML={{ __html: html }} />;',
  };
  for (const [name, code] of Object.entries(SINKS))
    it(`flags ${name}`, async () => {
      const result = await scan({ 'src/sink.tsx': code });
      expect(result.hits).toEqual(['src/sink.tsx']);
    });
});

describe('comments are removed by a tokenizer, so a URL string never hides a sink', () => {
  it('ignores a sink named only in a line or a block comment', async () => {
    const result = await scan({
      'src/doc.ts': ['// never set innerHTML', '/* nor outerHTML, nor DOMParser */', 'export const a = 1;'].join('\n'),
    });
    expect(result.hits).toEqual([]);
  });

  it('still sees a sink that follows a URL string on the same line (the old `//.*$` strip ate the rest of the line)', async () => {
    const result = await scan({ 'src/url.ts': 'const u = "https://example.test/a"; el.innerHTML = u;' });
    expect(result.hits).toEqual(['src/url.ts']);
  });

  it('still sees a sink after a template literal that holds `//`', async () => {
    const result = await scan({ 'src/tpl.ts': 'const u = `${a}//b`; el.outerHTML = u;' });
    expect(result.hits).toEqual(['src/tpl.ts']);
  });
});
