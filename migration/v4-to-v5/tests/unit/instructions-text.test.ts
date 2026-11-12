/**
 * The instructions document reaches the harness byte for byte: the v4 text (read by v4 with `readFile(path, 'utf8')`,
 * which keeps an initial U+FEFF) is the text 5.0's `ownInstructionsSource` hands back. Run through the real
 * Settings step, then the kernel configuration service over the written home, then the runtimes plugin's own reader.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { createConfigFiles } = await import(repo + '/packages/core/kernel/host/config/service.ts');
const { createNodeHostFs } = await import(repo + '/packages/core/kernel/host/state/host-fs.ts');
const { ownInstructionsSource } = await import(
  repo + '/packages/plugins/runtimes/daemon/adapters/own-instructions-source.ts'
);
const { INSTRUCTION_ITEMS, InstructionsFileSchema, INSTRUCTIONS_TEXT_LIMIT } = await import(
  repo + '/packages/plugins/runtimes/contract/index.ts'
);

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

async function plant(document: string | Uint8Array): Promise<void> {
  const put = async (path: string, content: string | Uint8Array): Promise<void> => {
    const target = join(f.from, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  await put(
    'config/components/instructions/main.yaml',
    'file: instructions/main.md\nharness: claude\nclonedFrom: source\nclonedFromDaemon: daemon\nclonedFromKey: key\n',
  );
  await put('fleet/assets/instructions/main.md', document);
  await put('config/profiles/main.yaml', 'contents:\n  - instructions/main\n');
}

async function readOwn(): Promise<unknown> {
  const files = createConfigFiles({
    home: f.to,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'runtimes', def: INSTRUCTION_ITEMS }],
  });
  await files.reload();
  return await ownInstructionsSource(files.port('runtimes')).read('main');
}

describe('the written instructions text is the v4 text, exactly', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['crlf', '# Rules\r\ntrailing spaces   \r\n'],
    ['markers', '# heading\n---\ncolon: value\n日本語 🦦\n'],
    ['boundary', 'x'.repeat(INSTRUCTIONS_TEXT_LIMIT)],
    ['leading BOM', '﻿# Rules\n'],
    ['BOM only', '﻿'],
    ['mid-text U+FEFF', '# Rules\n﻿keep﻿ this\n'],
    ['two leading BOMs', '﻿﻿# Rules\n'],
  ];
  for (const [name, document] of cases)
    test(name, async () => {
      await plant(document);
      const report = await settingsStep.run(f.ctx());
      expect(report.status).toBe('converted');
      const path = join(f.to, 'config/instructions/main.yaml');
      expect(InstructionsFileSchema.safeParse(parse(await readFile(path, 'utf8'))).success).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readOwn()).toMatchObject({
        text: document,
        harness: 'claude-code',
        clonedFrom: 'source',
        clonedFromDaemon: 'daemon',
        clonedFromKey: 'key',
      });
    });
});

describe('a document 5.0 cannot hold is refused by name, not altered', () => {
  const refused: readonly (readonly [string, string | Uint8Array])[] = [
    ['empty', ''],
    ['oversize', 'x'.repeat(INSTRUCTIONS_TEXT_LIMIT + 1)],
    ['control character', 'a\u0000b'],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])],
  ];
  for (const [name, document] of refused)
    for (const drop of [false, true])
      test(`${name}, dropUncarried=${drop}`, async () => {
        await plant(document);
        const report = await settingsStep.run({ ...f.ctx(), dropUncarried: drop });
        expect(report.status).toBe(drop ? 'converted' : 'pending');
        expect(report.notCarried.some(item => item.what === 'config/components/instructions/main.yaml')).toBe(true);
        expect(
          await stat(join(f.to, 'config/instructions/main.yaml')).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        const profile = parse(await readFile(join(f.to, 'config/profiles/main.yaml'), 'utf8')) as {
          contents: string[];
        };
        expect(profile.contents).toEqual(drop ? [] : ['instructions/main']);
      });
});
