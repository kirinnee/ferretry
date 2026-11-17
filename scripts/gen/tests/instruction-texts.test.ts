/**
 * The kernel snapshot reads each manifest's `instructions/<file>.md` through `instructionText`, and `fyd` answers it from
 * the generated `instructions.ts`. Without that map no manifest instruction reaches a ferret, so these tests pin it over
 * the REAL workspace: every declared instruction is in the map, as a text import the compiler can bundle, and the
 * module the generator wrote answers each key with exactly the file's words.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildModel, GENERATED, generateGlobal, instructionTexts, writeFiles } from '../registries.ts';

const root = join(import.meta.dir, '..', '..', '..');

describe('the generated instruction texts', async () => {
  const model = await buildModel(root);
  const declared = model.loaded.flatMap(subsystem =>
    (subsystem.manifest.instructions ?? []).map(entry => ({
      key: `${subsystem.id}/${entry.text}`,
      file: join(model.ws.byId(subsystem.id)?.dir ?? '', entry.text),
    })),
  );
  const source = instructionTexts(model);

  test('the real workspace declares instructions, and every one has a readable file', () => {
    expect(declared.length).toBeGreaterThan(0);
    for (const entry of declared) expect(existsSync(entry.file)).toBe(true);
  });

  test('every declared instruction is a bundled text import under its plugin-and-path key', () => {
    for (const entry of declared) expect(source).toContain(`${JSON.stringify(entry.key)}: instruction`);
    expect(source.match(/ with \{ type: 'text' \};/g)?.length).toBe(declared.length);
  });

  test('the map is part of the global registries, at the path fyd imports', () => {
    expect(generateGlobal(model).get(GENERATED.instructions)).toBe(source);
    expect(GENERATED.instructions).toBe('packages/core/kernel/src/generated/instructions.ts');
  });

  test('the module the generator writes answers every key with the file text, byte for byte', async () => {
    writeFiles(root, new Map([[GENERATED.instructions, source]]));
    const written = (await import(join(root, GENERATED.instructions))) as {
      readonly instructionTexts: Readonly<Record<string, string>>;
    };
    expect(Object.keys(written.instructionTexts).sort()).toEqual(declared.map(entry => entry.key).sort());
    for (const entry of declared) expect(written.instructionTexts[entry.key]).toBe(readFileSync(entry.file, 'utf8'));
  });
});
