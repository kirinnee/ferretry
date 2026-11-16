import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every file under a fixture folder, read once without blocking, by its path relative to that folder: a test module
 * awaits this at its top so its cases can name a fixture synchronously.
 */
export async function fixtureTexts(folder: string): Promise<(name: string) => string> {
  const names = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1));
  const texts = new Map(
    await Promise.all(names.map(async name => [name, await Bun.file(join(folder, name)).text()] as const)),
  );
  return name => {
    const text = texts.get(name);
    if (text === undefined) throw new Error(`no fixture ${name} under ${folder}`);
    return text;
  };
}
