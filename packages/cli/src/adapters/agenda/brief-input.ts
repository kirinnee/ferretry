import { isAbsolute, join } from 'node:path';
import type { IAgendaBriefInput } from '../../lib/agenda/ports.ts';
import { StdinConfigText } from '../config/stdin.ts';

/** Reads `--json-file`: a file relative to the working directory, or standard input for `-`. */
export class AgendaBriefInput implements IAgendaBriefInput {
  constructor(
    private readonly cwd: string,
    private readonly stdin: { read(): Promise<string> } = new StdinConfigText(),
  ) {}

  async read(path: string): Promise<string> {
    if (path === '-') return await this.stdin.read();
    const absolute = isAbsolute(path) ? path : join(this.cwd, path);
    try {
      return await Bun.file(absolute).text();
    } catch (error) {
      throw new Error(`cannot read ${path}: ${(error as Error).message}`);
    }
  }
}
