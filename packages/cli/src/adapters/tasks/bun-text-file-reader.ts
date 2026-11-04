import type { ITextFileReader } from '../../lib/tasks/ports';

/** Reads `--brief-file`, `--how-to-test-file` and `fy task patch --file`; `-` is standard input. The only filesystem touch the task commands make. */
export class BunTextFileReader implements ITextFileReader {
  async readText(path: string): Promise<string> {
    try {
      return path === '-' ? await Bun.stdin.text() : await Bun.file(path).text();
    } catch (error) {
      throw new Error(`cannot read ${path === '-' ? 'standard input' : path}: ${(error as Error).message}`);
    }
  }
}
