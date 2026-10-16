import type { IConfigInput } from '../../lib/config/ports.ts';

/** `fy config write`'s new text: standard input, whole and unaltered — YAML whitespace is meaning. */
export class StdinConfigText implements IConfigInput {
  constructor(private readonly stream: NodeJS.ReadableStream = process.stdin) {}

  async read(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
}
