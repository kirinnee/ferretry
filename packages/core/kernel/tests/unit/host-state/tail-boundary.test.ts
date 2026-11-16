import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineState } from '../../../contract/define.ts';
import type { StatePort } from '../../../contract/ports.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { MemoryStateFolder } from '../../../testing/state.ts';

const Log = defineState({ name: 'log', path: 'log.jsonl', store: 'jsonl', format: 1 });
const first = '{"format":1,"count":1}\n';
const last = '{"format":1,"count":2,"text":"🙂"}\n';
const lastBytes = new TextEncoder().encode(last).byteLength;

for (const kind of ['host memory', 'host disk', 'test host'] as const) {
  test(`U tail preserves complete first lines at exact byte boundaries: ${kind}`, async () => {
    let cleanup = async (): Promise<void> => {};
    let port: StatePort;
    let seed: (text: string) => Promise<void>;
    if (kind === 'test host') {
      const folder = new MemoryStateFolder();
      port = folder.port([Log]);
      seed = async text => {
        folder.plant(Log, text);
      };
    } else if (kind === 'host memory') {
      const fs = createMemoryHostFs();
      port = createStatePort({ home: '/fixture', pluginId: 'demo', files: [Log], fs });
      seed = async text => {
        fs.seed('/fixture/state/demo/log.jsonl', text);
      };
    } else {
      const home = await mkdtemp(join(tmpdir(), 'kernel-tail-boundary-'));
      cleanup = () => rm(home, { recursive: true, force: true });
      await mkdir(join(home, 'state/demo'), { recursive: true });
      port = createStatePort({ home, pluginId: 'demo', files: [Log], fs: createNodeHostFs() });
      seed = async text => {
        await writeFile(join(home, 'state/demo/log.jsonl'), text);
      };
    }
    try {
      await seed(first + last);
      const expected = { records: [{ count: 2, text: '🙂' }], unreadable: 0 };
      expect(await port.tail(Log, { maxBytes: lastBytes })).toEqual(expected);
      expect(await port.tail(Log, { maxBytes: lastBytes + 1 })).toEqual(expected);
      expect(await port.tail(Log, { maxBytes: lastBytes - 1 })).toEqual({ records: [], unreadable: 0 });
      expect(await port.tail(Log, { maxBytes: 1 })).toEqual({ records: [], unreadable: 0 });
      expect((await port.tail(Log, { maxBytes: first.length + lastBytes })).records).toHaveLength(2);
      await seed(first + last.trimEnd());
      expect(await port.tail(Log, { maxBytes: lastBytes - 1 })).toEqual(expected);
      await seed(`${first}not json\n`);
      expect(await port.tail(Log, { maxBytes: 9 })).toEqual({ records: [], unreadable: 1 });
    } finally {
      await cleanup();
    }
  });
}
