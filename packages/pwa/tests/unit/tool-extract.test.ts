import { describe, it } from 'bun:test';
import should from 'should';
import {
  extractToolSummary,
  firstLine,
  langFromPath,
  parseExecOutput,
  resultImages,
  resultText,
  toolColorVar,
} from '../../src/lib/tool-extract.ts';

describe('firstLine', () => {
  it('should keep a single-line value whole', () => {
    // Act
    const actual = firstLine('  bun test  ');

    // Assert
    should(actual).equal('bun test');
  });

  it('should cut a multi-line value at its first break', () => {
    // Act
    const actual = firstLine('bun test\n--coverage');

    // Assert
    should(actual).equal('bun test');
  });
});

describe('parseExecOutput', () => {
  it('should split the codex wall-time prefix off the output', () => {
    // Arrange
    const raw = 'Script completed\nWall time 1.25 seconds\nOutput:\nall green';

    // Act
    const actual = parseExecOutput(raw);

    // Assert
    should(actual).deepEqual({ wallTime: '1.25 seconds', cleanText: 'all green' });
  });

  it('should leave output without the prefix untouched', () => {
    // Act
    const actual = parseExecOutput('all green');

    // Assert
    should(actual).deepEqual({ cleanText: 'all green' });
  });
});

describe('extractToolSummary — codex string inputs', () => {
  it('should read a quoted exec command and decode its escapes', () => {
    // Arrange
    const input = 'cmd: "echo \\"hi\\"\\ncd \\\\tmp\\n echo \\$HOME"';

    // Act
    const actual = extractToolSummary('exec', input);

    // Assert
    should(actual.verb).equal('Bash');
    should(actual.headline).equal('echo "hi"');
    should(actual.bodyLines).deepEqual(['echo "hi"', 'cd \\tmp', ' echo $HOME']);
    should(actual.kind).equal('bash');
    should(actual.isExec).be.true();
  });

  it('should read a backticked exec command', () => {
    // Act
    const actual = extractToolSummary('exec', 'cmd: `bun test`');

    // Assert
    should(actual.headline).equal('bun test');
    should(actual.kind).equal('bash');
  });

  it('should fall through to the generic reading when exec carries no command', () => {
    // Act
    const actual = extractToolSummary('exec', 'no command here');

    // Assert
    should(actual.verb).equal('Exec');
    should(actual.kind).equal('generic');
    should(actual.headline).equal('no command here');
  });

  it('should recognise a bare patch body by its Begin Patch marker', () => {
    // Arrange
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n+ line';

    // Act
    const actual = extractToolSummary('shell', patch);

    // Assert
    should(actual.verb).equal('Patch');
    should(actual.headline).equal('Update src/app.ts');
    should(actual.kind).equal('patch');
    should(actual.bodyLines.length).equal(3);
  });

  it('should name a patch tool whose input is not a string', () => {
    // Act
    const actual = extractToolSummary('apply_patch', 42);

    // Assert
    should(actual.headline).equal('apply_patch');
    should(actual.bodyLines).deepEqual(['']);
  });

  it('should recognise a plan update declared inside a string input', () => {
    // Act
    const actual = extractToolSummary('shell', 'update_plan step 2\nrest');

    // Assert
    should(actual.verb).equal('Plan');
    should(actual.headline).equal('update_plan');
    should(actual.bodyLines).deepEqual(['update_plan step 2']);
    should(actual.kind).equal('plan');
  });

  it('should read a named plan update with a non-string input', () => {
    // Act
    const actual = extractToolSummary('update_plan', 7);

    // Assert
    should(actual.bodyLines).deepEqual(['plan update']);
  });

  it('should preview only the first lines of an unrecognised string input', () => {
    // Arrange
    const input = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');

    // Act
    const actual = extractToolSummary('mystery', input);

    // Assert
    should(actual.verb).equal('Mystery');
    should(actual.headline).equal('line 0');
    should(actual.bodyLines.length).equal(40);
  });
});

describe('extractToolSummary — claude object inputs', () => {
  it('should read a bash call with its description', () => {
    // Act
    const actual = extractToolSummary('Bash', { command: 'bun test\n--coverage', description: 'run the suite' });

    // Assert
    should(actual.verb).equal('Bash');
    should(actual.headline).equal('bun test');
    should(actual.detail).equal('run the suite');
    should(actual.bodyLines).deepEqual(['bun test', '--coverage']);
    should(actual.isExec).be.true();
  });

  it('should name a bash call that carries no command', () => {
    // Act
    const actual = extractToolSummary('bash', {});

    // Assert
    should(actual.headline).equal('Bash');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should fall through when a bash call carries no object input', () => {
    // Act
    const actual = extractToolSummary('bash', 12);

    // Assert
    should(actual.kind).equal('generic');
    should(actual.headline).equal('bash');
  });

  it('should read a file path down to its base name', () => {
    // Act
    const actual = extractToolSummary('Read', { file_path: '/work/repo/src/app.ts' });

    // Assert
    should(actual.verb).equal('Read');
    should(actual.headline).equal('app.ts');
    should(actual.detail).equal('/work/repo/src/app.ts');
    should(actual.filePath).equal('/work/repo/src/app.ts');
  });

  it('should keep a path with no segments as the headline', () => {
    // Act
    const actual = extractToolSummary('read', { path: '/' });

    // Assert
    should(actual.headline).equal('/');
  });

  it('should strip a query string before taking the base name', () => {
    // Act
    const actual = extractToolSummary('read', { filePath: 'docs/guide.md?raw=1' });

    // Assert
    should(actual.headline).equal('guide.md');
  });

  it('should name a read call with no path at all', () => {
    // Act
    const actual = extractToolSummary('read', 'not an object');

    // Assert
    should(actual.headline).equal('Read');
    should(actual.bodyLines).deepEqual([]);
    should(actual.filePath === undefined).be.true();
  });

  it('should show a write call as its path then its content', () => {
    // Act
    const actual = extractToolSummary('write', { file_path: 'a/b.txt', content: 'one\ntwo' });

    // Assert
    should(actual.verb).equal('Write');
    should(actual.bodyLines).deepEqual(['a/b.txt', '', 'one', 'two']);
  });

  it('should stringify non-string write content', () => {
    // Act
    const actual = extractToolSummary('write', { file_path: 'a.json', content: { key: 1 } });

    // Assert
    should(actual.bodyLines).deepEqual(['a.json', '', '{', '  "key": 1', '}']);
  });

  it('should describe write content that cannot be serialised', () => {
    // Arrange
    const content: Record<string, unknown> = {};
    content['self'] = content;

    // Act
    const actual = extractToolSummary('write', { file_path: 'a.json', content });

    // Assert
    should(actual.bodyLines).deepEqual(['a.json', '', '[object Object]']);
  });

  it('should name a write call with no path', () => {
    // Act
    const actual = extractToolSummary('write', {});

    // Assert
    should(actual.headline).equal('Write');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should show an edit as an old block then a new block', () => {
    // Act
    const actual = extractToolSummary('edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two\nthree' });

    // Assert
    should(actual.verb).equal('Edit');
    should(actual.headline).equal('a.ts');
    should(actual.bodyLines).deepEqual(['- old', 'one', '+ new', 'two', 'three']);
  });

  it('should name an edit that carries neither side', () => {
    // Act
    const actual = extractToolSummary('multi_edit', {});

    // Assert
    should(actual.headline).equal('Edit');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should read a patch carried on a named patch tool', () => {
    // Act
    const actual = extractToolSummary('notebookedit', { patch: '*** Add File: new.ts\n+x' });

    // Assert
    should(actual.verb).equal('Patch');
    should(actual.headline).equal('Add new.ts');
  });

  it('should fall back to apply_patch when a patch has no file header', () => {
    // Act
    const actual = extractToolSummary('patch', { patch: 'nothing recognisable' });

    // Assert
    should(actual.headline).equal('apply_patch');
  });

  it('should read a wait call by its cell', () => {
    // Act
    const actual = extractToolSummary('wait', { cell_id: 'c-9' });

    // Assert
    should(actual.verb).equal('Wait');
    should(actual.headline).equal('cell c-9');
    should(actual.kind).equal('wait');
  });

  it('should name a wait call with no cell', () => {
    // Act
    const actual = extractToolSummary('wait', undefined);

    // Assert
    should(actual.headline).equal('wait');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should read a search call by its pattern', () => {
    // Act
    const actual = extractToolSummary('grep', { pattern: 'daemonId' });

    // Assert
    should(actual.verb).equal('Grep');
    should(actual.headline).equal('daemonId');
    should(actual.kind).equal('search');
    should(actual.bodyLines).deepEqual(['{\n  "pattern": "daemonId"\n}']);
  });

  it('should name a search call that carries no query', () => {
    // Act
    const actual = extractToolSummary('websearch', 5);

    // Assert
    should(actual.headline).equal('websearch');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should read an unknown object tool by its first informative key', () => {
    // Act
    const actual = extractToolSummary('teleport', { destination: 'x', prompt: 'take me\nhome' });

    // Assert
    should(actual.verb).equal('Teleport');
    should(actual.headline).equal('take me');
    should(actual.kind).equal('generic');
  });

  it('should name an unknown object tool with no informative key', () => {
    // Act
    const actual = extractToolSummary('teleport', { count: 3 });

    // Assert
    should(actual.headline).equal('teleport');
  });

  it('should name an anonymous tool with no readable input', () => {
    // Act
    const actual = extractToolSummary(undefined, [1, 2]);

    // Assert
    should(actual.verb).equal('Tool');
    should(actual.headline).equal('tool');
    should(actual.bodyLines).deepEqual([]);
  });

  it('should leave an empty tool name empty rather than inventing one', () => {
    // Act
    const actual = extractToolSummary('', { count: 1 });

    // Assert
    should(actual.verb).equal('');
    should(actual.headline).equal('');
  });
});

describe('toolColorVar', () => {
  it('should name the theme variable for a tool kind', () => {
    // Act
    const actual = toolColorVar('bash');

    // Assert
    should(actual).equal('var(--tool-bash)');
  });
});

describe('langFromPath', () => {
  it('should map a known extension to its language', () => {
    // Act
    const actual = langFromPath('src/app.tsx');

    // Assert
    should(actual).equal('typescript');
  });

  it('should recognise a Dockerfile by name', () => {
    // Act
    const actual = langFromPath('build/Dockerfile');

    // Assert
    should(actual).equal('dockerfile');
  });

  it('should answer nothing for a file with no extension', () => {
    // Act
    const actual = langFromPath('LICENSE');

    // Assert
    should(actual === undefined).be.true();
  });

  it('should answer nothing when there is no path', () => {
    // Act
    const actual = langFromPath();

    // Assert
    should(actual === undefined).be.true();
  });
});

describe('resultImages', () => {
  it('should keep base64 raster blocks', () => {
    // Arrange
    const result = {
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    };

    // Act
    const actual = resultImages(result);

    // Assert
    should(actual).deepEqual([{ mediaType: 'image/png', data: 'AAAA' }]);
  });

  it('should refuse svg, non-base64 sources, empty data and malformed blocks', () => {
    // Arrange
    const result = {
      content: [
        null,
        'text',
        { type: 'image' },
        { type: 'image', source: 'nope' },
        { type: 'image', source: { type: 'url', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 7, data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 7 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      ],
    };

    // Act
    const actual = resultImages(result);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should answer nothing when the result carries no content list', () => {
    // Act
    const actual = resultImages({ text: 'done' });

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('resultText', () => {
  it('should prefer the plain text field', () => {
    // Act
    const actual = resultText({ text: 'done' });

    // Assert
    should(actual).equal('done');
  });

  it('should join text parts and label non-text blocks', () => {
    // Act
    const actual = resultText({
      content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'resource' }, {}],
    });

    // Assert
    should(actual).equal('one\n[resource]\n[unknown]');
  });

  it('should answer nothing for an empty content list', () => {
    // Act
    const actual = resultText({ content: [] });

    // Assert
    should(actual === null).be.true();
  });

  it('should stringify a structured content value', () => {
    // Act
    const actual = resultText({ content: { code: 2 } });

    // Assert
    should(actual).equal('{\n  "code": 2\n}');
  });

  it('should answer nothing when the result carries no readable content', () => {
    // Act
    const actual = resultText({ isError: true });

    // Assert
    should(actual === null).be.true();
  });
});
