import { PassThrough } from 'node:stream';
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

  it('can ask a question only where stdin and stdout are both a terminal, so a script is never asked', () => {
    const io = new ConsoleIo();
    setTty(process.stdin, true);
    setTty(process.stdout, true);
    should(typeof io.ask).eql('function');
    setTty(process.stdout, false);
    should(io.ask).be.undefined();
    setTty(process.stdin, false);
    setTty(process.stdout, true);
    should(io.ask).be.undefined();
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

  it('reports stdin on its own, so a redirected stdout does not make a typing terminal look piped', () => {
    const io = new ConsoleIo();
    setTty(process.stdin, true);
    setTty(process.stdout, false);
    should(io.stdinIsTty).be.true();
    should(io.isTty).be.false();
    setTty(process.stdin, undefined);
    setTty(process.stdout, true);
    should(io.stdinIsTty).be.false();
  });

  /** Types one line into the process's own stdin once the question is on stderr, as a person at a terminal would. */
  async function answerWith(line: string): Promise<{ answer: string; asked: string }> {
    // A stream of its own: the real stdin may be closed or shared with other files, and would end the question.
    const input = new PassThrough();
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    restores.push(() => {
      if (stdin !== undefined) Object.defineProperty(process, 'stdin', stdin);
    });
    setTty(input as never, true);
    setTty(process.stdout, true);
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(() => err.mockRestore());
    const ask = new ConsoleIo().ask;
    if (ask === undefined) throw new Error('expected a terminal');
    const pending = ask('Continue?');
    // readline attaches to stdin as ask starts; let it settle before the line arrives.
    input.write(line);
    const answer = await pending;
    return { answer, asked: err.mock.calls.map(call => String(call[0])).join('') };
  }

  it('asks on stderr and returns what the person typed, without the line break', async () => {
    const { answer, asked } = await answerWith('yes\n');
    should(answer).eql('yes');
    should(asked).containEql('Continue? ');
  });

  it('returns an empty answer when the person just presses enter', async () => {
    const { answer } = await answerWith('\n');
    should(answer).eql('');
  });

  it('closes its prompt after answering, so a second question is a fresh one', async () => {
    should((await answerWith('one\n')).answer).eql('one');
    should((await answerWith('two\n')).answer).eql('two');
  });
});
