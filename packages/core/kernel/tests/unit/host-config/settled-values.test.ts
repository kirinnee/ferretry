import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/define.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { ownSecretsPort } from '../../../host/secrets.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, manualClock } from './support.ts';

test('NN2 config readers cannot add secret authority by mutating file or collection values', async () => {
  const schema = z.object({ nested: z.object({ refs: z.array(z.string()) }) });
  const file = defineConfig({ file: 'own.yaml', schema, axis: 'configure', loosens: () => [] });
  const collection = defineConfig({
    collection: 'own',
    name: /^[a-z]+$/,
    schema,
    axis: 'configure',
    loosens: () => [],
  });
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: '/fixture',
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'probe', def: file },
      { plugin: 'probe', def: collection },
    ],
  });
  await files.write('probe', file, undefined, 'nested:\n  refs: [plain]\n');
  await files.write('probe', collection, 'one', 'nested:\n  refs: [plain]\n');
  const port = files.port('probe');
  const secrets = ownSecretsPort(
    ['TARGET'],
    () => files.secretReferences('probe'),
    () => ({ resolve: async () => 'fixture' }),
  );
  for (const value of [port.file(file), port.collection(collection).get('one')]) {
    if (value === undefined) throw new Error('missing fixture');
    value.nested.refs.push('${secret:TARGET}');
    expect(await secrets.resolve('TARGET')).toEqual({ refused: 'not_configured' });
  }
  expect(port.file(file)?.nested.refs).toEqual(['plain']);
  expect(port.collection(collection).get('one')?.nested.refs).toEqual(['plain']);
  expect(files.held()).toEqual([]);
  expect(await fs.readText('/fixture/config/own.yaml')).not.toContain('TARGET');
});
