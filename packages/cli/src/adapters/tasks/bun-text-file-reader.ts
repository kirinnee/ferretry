import type { ITextFileReader } from '../../lib/tasks/ports';

/** Reads `--description-file` and the other `-file` flags; `-` is standard input. The only filesystem touch the task commands make. */
export class BunTextFileReader implements ITextFileReader {
  async readText(path: string): Promise<string> {
    try {
      return await (path === '-' ? Bun.stdin : Bun.file(path)).text();
    } catch (error) {
      throw new Error(`cannot read ${path}: ${(error as Error).message}`);
    }
  }
}
