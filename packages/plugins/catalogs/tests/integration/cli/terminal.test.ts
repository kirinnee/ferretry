import { describe, it } from 'bun:test';
import type { CliContext } from '@ferretry/kernel/manifest';
import should from 'should';
import { FileCatalogWriter } from '../../../cli/adapters/export-file.ts';
import { catalogTerminal } from '../../../cli/adapters/terminal.ts';

interface Stand {
  readonly out: string[];
  readonly err: string[];
}

/** A shell context that records what it was told to print; each facility is given only when a test asks for it. */
const shell = (
  extra: Record<string, unknown> = {},
  isTty = true,
): { readonly ctx: CliContext<never>; readonly stand: Stand } => {
  const stand: Stand = { out: [], err: [] };
  const ctx = {
    io: { out: (text: string) => stand.out.push(text), err: (text: string) => stand.err.push(text), isTty },
    ...extra,
  } as unknown as CliContext<never>;
  return { ctx, stand };
};

describe('the catalogs CLI terminal', () => {
  it('should write every kind of message to the shell terminal and keep the exit code it was given', () => {
    // Arrange
    const { ctx, stand } = shell();
    const { out } = catalogTerminal(ctx);

    // Act
    out.report('report');
    out.success('success');
    out.warn('warn');
    out.error('error');
    out.diagnostic('diagnostic');
    const before = out.exitCode;
    out.setExitCode(3);

    // Assert
    should(stand.out).eql(['report', 'success', 'warn']);
    should(stand.err).eql(['error', 'diagnostic']);
    should(before).equal(0);
    should(out.exitCode).equal(3);
  });

  it('should write a QR verbatim to the terminal', () => {
    // Arrange
    const { ctx, stand } = shell();

    // Act
    catalogTerminal(ctx).screen.write('██  ██');

    // Assert
    should(stand.out).eql(['██  ██']);
  });

  it('should ask through the shell when it can, and read no answer when it cannot', async () => {
    // Arrange
    const asked: string[] = [];
    const answering = shell({
      prompt: async (message: string) => {
        asked.push(message);
        return 'y';
      },
    });
    const silent = shell({ prompt: async () => undefined });
    const none = shell();

    // Act / Assert
    should(await catalogTerminal(answering.ctx).prompt.ask('Sign it?')).equal('y');
    should(asked).eql(['Sign it?']);
    should(await catalogTerminal(silent.ctx).prompt.ask('Sign it?')).equal('');
    should(await catalogTerminal(none.ctx).prompt.ask('Sign it?')).equal('');
  });

  it('should be interactive only at a terminal with a shell that can ask', () => {
    // Arrange / Act / Assert
    should(catalogTerminal(shell({ prompt: async () => 'y' }, true).ctx).interactive).be.true();
    should(catalogTerminal(shell({ prompt: async () => 'y' }, false).ctx).interactive).be.false();
    should(catalogTerminal(shell({}, true).ctx).interactive).be.false();
  });

  it('should read a file through the shell once, and refuse a read the shell cannot do', async () => {
    // Arrange
    const reads: string[] = [];
    const { ctx } = shell({
      readText: async (path: string) => {
        reads.push(path);
        return 'héllo';
      },
    });
    const { reader } = catalogTerminal(ctx);
    const bare = catalogTerminal(shell().ctx).reader;

    // Act
    const size = await reader.size('./a.json');
    const text = await reader.read('./a.json', 100);

    // Assert
    should(size).equal(6);
    should(text).equal('héllo');
    should(reads).eql(['./a.json']);
    await should(reader.read('./a.json', 3)).be.rejectedWith('./a.json grew past 3 bytes while being read');
    await should(bare.read('./b.json', 10)).be.rejectedWith(/cannot read a file for Catalogs yet/u);
  });

  it('should take the size from a stat when the shell has one, without reading the file', async () => {
    // Arrange
    const reads: string[] = [];
    const { ctx } = shell({
      readText: async (path: string) => {
        reads.push(path);
        return 'never';
      },
      files: { exists: async () => false, write: async () => undefined, size: async () => 9_999 },
    });

    // Act
    const size = await catalogTerminal(ctx).reader.size('./big.json');

    // Assert
    should(size).equal(9_999);
    should(reads).eql([]);
  });

  it('should write through the shell files, and use the file system writer when the shell has none', async () => {
    // Arrange
    const written: string[] = [];
    const files = {
      exists: async (path: string) => path === './there.json',
      write: async (path: string, text: string, overwrite: boolean) => {
        written.push(`${path}|${text}|${String(overwrite)}`);
      },
    };
    const given = catalogTerminal(shell({ files }).ctx).writer;
    const fallback = catalogTerminal(shell().ctx).writer;

    // Act
    const exists = await given.exists('./there.json');
    await given.write('./out.json', '{}', true);

    // Assert
    should(exists).be.true();
    should(written).eql(['./out.json|{}|true']);
    should(fallback).be.instanceOf(FileCatalogWriter);
    should(await fallback.exists('./this-file-is-not-there.catalog.json')).be.false();
  });

  it('should report the terminal width the shell gives, and none when it gives none', () => {
    // Arrange / Act / Assert
    should(catalogTerminal(shell({ columns: () => 120 }).ctx).size.columns()).equal(120);
    should(catalogTerminal(shell().ctx).size.columns()).be.undefined();
  });
});
