import { BoardSwitchUnavailableError } from '../../lib/board-projects/errors.ts';
import {
  type BoardSwitchDocument,
  BoardSwitchDocumentSchema,
  type BoardSwitchMutation,
  type BoardSwitchStore,
} from '../../lib/board-projects/index.ts';
import { AtomicFileWriter } from '../atomic-file/atomic-file.ts';
import { KeyedSerialExecutor, type SerialExecutor } from '../atomic-file/serial-executor.ts';

/**
 * The one board switch document at `path`. A document that does not parse is refused and never overwritten:
 * the evidence stays for an operator, and no board is read as on or off on a guess.
 */
export class FileBoardSwitchStore implements BoardSwitchStore {
  constructor(
    private readonly path: string,
    private readonly writer: AtomicFileWriter = new AtomicFileWriter(),
    private readonly executor: SerialExecutor = new KeyedSerialExecutor(),
  ) {}

  async read(): Promise<BoardSwitchDocument | null> {
    return await this.load();
  }

  async transact<T>(decide: (current: BoardSwitchDocument | null) => BoardSwitchMutation<T>): Promise<T> {
    return await this.executor.run(this.path, async () => {
      const mutation = decide(await this.load());
      if (mutation.next !== undefined)
        await this.writer.write(this.path, `${JSON.stringify(mutation.next, null, 2)}\n`);
      return mutation.result;
    });
  }

  private async load(): Promise<BoardSwitchDocument | null> {
    const text = await this.writer.read(this.path);
    if (text === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BoardSwitchUnavailableError(`refusing to use a damaged board switch at ${this.path}: not JSON`);
    }
    const parsed = BoardSwitchDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw new BoardSwitchUnavailableError(
        `refusing to use a damaged board switch at ${this.path}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}
