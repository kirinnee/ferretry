import type { ITextFileReader } from '../../lib/tasks/ports';

/** Reads `--description-file`. The only filesystem touch the task commands make. */
export class BunTextFileReader implements ITextFileReader {
  async readText(path: string): Promise<string> {
    try {
      return await Bun.file(path).text();
    } catch (error) {
      throw new Error(`cannot read ${path}: ${(error as Error).message}`);
    }
  }
}
