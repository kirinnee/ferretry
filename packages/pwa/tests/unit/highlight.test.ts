import { describe, it } from 'bun:test';
import should from 'should';
import { escapeHtml, fenceLanguage, highlightToHtml, isKnownLanguage } from '../../src/lib/highlight.ts';
import { langFromPath } from '../../src/lib/tool-extract.ts';

describe('escapeHtml', () => {
  it('should neutralise every character that could open a tag', () => {
    // Act
    const actual = escapeHtml('<script>a && b</script>');

    // Assert
    should(actual).equal('&lt;script&gt;a &amp;&amp; b&lt;/script&gt;');
  });
});

describe('isKnownLanguage', () => {
  it('should recognise a registered language', () => {
    // Act
    const actual = isKnownLanguage('typescript');

    // Assert
    should(actual).be.true();
  });

  it('should recognise the fence aliases the registry adds by hand', () => {
    // Act
    const actual = ['yml', 'toml', 'patch', 'txt', 'shell', 'console', 'sh-session'].map(isKnownLanguage);

    // Assert
    should(actual).deepEqual([true, true, true, true, true, true, true]);
  });

  it('should refuse a language nobody registered', () => {
    // Act
    const actual = isKnownLanguage('brainfuck');

    // Assert
    should(actual).be.false();
  });

  it('should refuse a missing language', () => {
    // Act
    const actual = isKnownLanguage();

    // Assert
    should(actual).be.false();
  });

  it('should register every language the extension table can name', () => {
    // Arrange — the two tables are only useful together: an extension that maps
    // to an unregistered id silently renders as plain text.
    const extensions = [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'json',
      'md',
      'mdx',
      'css',
      'scss',
      'html',
      'xml',
      'svg',
      'sh',
      'bash',
      'zsh',
      'fish',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'c',
      'h',
      'cpp',
      'cc',
      'hpp',
      'cs',
      'php',
      'yml',
      'yaml',
      'toml',
      'ini',
      'sql',
      'lua',
      'nix',
      'swift',
      'scala',
      'pl',
      'r',
      'diff',
      'patch',
    ];

    // Act
    const unregistered = extensions.filter(extension => !isKnownLanguage(langFromPath(`file.${extension}`)));

    // Assert
    should(unregistered).deepEqual([]);
  });
});

describe('highlightToHtml', () => {
  it('should tokenize a recognised language', () => {
    // Act
    const actual = highlightToHtml('const x = 1;', 'typescript');

    // Assert
    should(actual).containEql('hljs-keyword');
  });

  it('should escape the source it tokenizes rather than passing markup through', () => {
    // Act
    const actual = highlightToHtml('const x = "<img src=x onerror=alert(1)>";', 'typescript');

    // Assert
    should(actual).not.containEql('<img');
    should(actual).containEql('&lt;img');
  });

  it('should answer nothing when no language was named', () => {
    // Act
    const actual = highlightToHtml('plain text');

    // Assert
    should(actual === null).be.true();
  });

  it('should answer nothing for an unregistered language', () => {
    // Act
    const actual = highlightToHtml('code', 'brainfuck');

    // Assert
    should(actual === null).be.true();
  });

  it('should refuse a blob too large to be worth tokenizing', () => {
    // Arrange
    const huge = 'x'.repeat(60_001);

    // Act
    const actual = highlightToHtml(huge, 'typescript');

    // Assert
    should(actual === null).be.true();
  });

  it('should fall back to plain text when the parser throws', () => {
    // Arrange
    const exploding = () => {
      throw new Error('parser gave up');
    };

    // Act
    const actual = highlightToHtml('const x = 1;', 'typescript', exploding);

    // Assert
    should(actual === null).be.true();
  });
});

describe('fenceLanguage', () => {
  it('should read the language a markdown fence declared', () => {
    // Act
    const actual = fenceLanguage('language-TS hljs');

    // Assert
    should(actual).equal('ts');
  });

  it('should answer nothing for a class list with no language', () => {
    // Act
    const actual = fenceLanguage('hljs');

    // Assert
    should(actual === undefined).be.true();
  });

  it('should answer nothing when there is no class list at all', () => {
    // Act
    const actual = fenceLanguage();

    // Assert
    should(actual === undefined).be.true();
  });
});
