import { afterAll, afterEach, describe, it, spyOn } from 'bun:test';
import should from 'should';
import { ConsoleIo } from '../../../src/adapters/terminal/console-io.ts';

/** The real terminal port, against the process's own streams: stdout is the answer, stderr everything else. */
describe('ConsoleIo', () => {
  // Every integration file shares this process, so the streams must be left exactly as they were found.
  const original = {
    stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
    stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  };
  const restores: (() => void)[] = [];
  afterEach(() => {
    // Last in, first out: a property stubbed twice must end on the descriptor it had before the first stub.
    for (const restore of restores.splice(0).reverse()) restore();
  });
  afterAll(() => {
    should(Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')).eql(original.stdin);
    should(Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')).eql(original.stdout);
  });

  /** Replaces one stream property for this test only, and restores the exact descriptor afterwards. */
  function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined): void {
    const before = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
    restores.push(() => {
      if (before === undefined) Reflect.deleteProperty(stream, 'isTTY');
      else Object.defineProperty(stream, 'isTTY', before);
    });
  }

  it('writes an answer to stdout and nothing else to stderr', () => {
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(
      () => out.mockRestore(),
      () => err.mockRestore(),
    );

    const io = new ConsoleIo();
    io.out('answer\n');
    io.err('note\n');

    should(out.mock.calls).eql([['answer\n']]);
    should(err.mock.calls).eql([['note\n']]);
  });

  it('is a terminal only when stdin and stdout both are', () => {
    const io = new ConsoleIo();
    setTty(process.stdin, true);
    setTty(process.stdout, true);
    should(io.isTty).be.true();
    setTty(process.stdout, undefined);
    should(io.isTty).be.false();
    setTty(process.stdin, false);
    setTty(process.stdout, true);
    should(io.isTty).be.false();
  });
});
