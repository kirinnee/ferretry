import type { AttentionId } from '@ferretry/protocol';
import { describe, test } from 'bun:test';
import should from 'should';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  findReferences,
  formatCodeReference,
  formatReference,
  parseReferenceHref,
  parseReferenceToken,
  type Reference,
  referenceHref,
  referenceIdentity,
  remarkReferences,
  resolveReference,
  type ResolvedAgent,
  type ResolvedReference,
  revalidateReference,
} from '../../src/lib/references.ts';

const daemonId = 'daemon-a' as DaemonId;

/** A live fleet answer for the daemon under test. */
const agent = (sessionId: string, name = 'zelda'): ResolvedAgent => ({ daemonId, sessionId, name });

/** Reads a node's children as a list, so assertions stay one expression long. */
const kids = (node: MdTree | undefined): MdTree[] => node?.children ?? [];

/** The mdast subset the remark transform reads and rewrites. */
interface MdTree {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: { hProperties?: Record<string, string> };
  children?: MdTree[];
}

describe('parseReferenceToken', () => {
  const canonical: readonly (readonly [string, Reference])[] = [
    [':zelda', { kind: 'agent', name: 'zelda' }],
    [':ZELDA', { kind: 'agent', name: 'zelda' }],
    ['@handover.md', { kind: 'file', path: 'handover.md' }],
    ['@./handover.md', { kind: 'file', path: './handover.md' }],
    ['@/abs/api.ts', { kind: 'file', path: '/abs/api.ts' }],
    ['@src/api.ts:120', { kind: 'file', path: 'src/api.ts', line: 120 }],
    ['@src/api.ts:120-140', { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 }],
    ['@src/api.ts:120-120', { kind: 'file', path: 'src/api.ts', line: 120, endLine: 120 }],
    ['&F12', { kind: 'task', id: 'F12' }],
    ['&f12', { kind: 'task', id: 'F12' }],
    ['!A3', { kind: 'attention', id: 'A3' }],
    ['/liftoff-ops', { kind: 'skill', name: 'liftoff-ops' }],
    ['$liftoff-ops', { kind: 'skill', name: 'liftoff-ops' }],
    [':term/0a1b2c3d4e5f', { kind: 'terminal', id: '0a1b2c3d4e5f' }],
    [':page/AB12cd_-.9', { kind: 'browser', id: 'AB12cd_-.9' }],
  ];

  for (const [raw, expected] of canonical) {
    test(`should parse ${raw}`, () => {
      // Act
      const actual = parseReferenceToken(raw);

      // Assert
      should(actual).deepEqual(expected);
    });
  }

  const rejected = [
    '',
    '@',
    '@@src/api.ts',
    '@@@src/api.ts',
    'src/api.ts',
    'src/api.ts:12',
    '@src/api.ts:0',
    '@src/api.ts:12-0',
    '@src/api.ts:14-12',
    '@src/api.ts:12:4',
    '@src/',
    '@src//api.ts',
    '@a/./b.ts',
    '@../secret',
    '@a/../secret',
    '#F12',
    '?A3',
    ':1zelda',
    ':zelda_name',
    '&A3',
    '!A0',
    'pin:thing',
    '/',
    '$',
    '/1skill',
    '/skill_name',
    // Lowercase only: `$HOME` is a shell variable, not the `home` skill.
    '/Liftoff-Ops',
    '$HOME',
    // A harness may accept these invocation forms; this grammar does not,
    // because `:` and `/` are its own boundaries.
    '/plugin:skill',
    '$apps/web:deploy',
    // Twelve lowercase hex digits exactly, mirroring the daemon's terminal ids.
    ':term/0A1B2C3D4E5F',
    ':term/0a1b2c3d4e5',
    ':term/0a1b2c3d4e5fa',
    ':term/',
    ':page/',
    ':page/-leading-punctuation',
    ':page/trailing-',
    ':page/trailing.',
  ];

  for (const raw of rejected) {
    test(`should reject the non-canonical token ${JSON.stringify(raw)}`, () => {
      // Act
      const actual = parseReferenceToken(raw);

      // Assert
      should(actual).be.null();
    });
  }

  test('should drop a location that is not a safe integer rather than reject the file', () => {
    // Act — the reader mashed digits; the path is still a real reference.
    const actual = parseReferenceToken('@src/api.ts:99999999999999999999');

    // Assert
    should(actual).deepEqual({ kind: 'file', path: 'src/api.ts' });
  });

  test('should reject a range whose location is unusable but whose end line is not', () => {
    // Act
    const actual = parseReferenceToken('@src/api.ts:99999999999999999999-140');

    // Assert
    should(actual).be.null();
  });
});

describe('findReferences', () => {
  test('should find all four kinds at exact offsets and leave non-boundaries alone', () => {
    // Arrange
    const text =
      'Ping :zelda; inspect @src/api.ts:120-140, then &F12 and !A3. Ignore x:link, word&F2, !!A4, @@@, #F9, ?A8.';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual).deepEqual([
      {
        reference: { kind: 'agent', name: 'zelda' },
        raw: ':zelda',
        start: text.indexOf(':zelda'),
        end: text.indexOf(':zelda') + ':zelda'.length,
      },
      {
        reference: { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 },
        raw: '@src/api.ts:120-140',
        start: text.indexOf('@src/api.ts'),
        end: text.indexOf('@src/api.ts') + '@src/api.ts:120-140'.length,
      },
      {
        reference: { kind: 'task', id: 'F12' },
        raw: '&F12',
        start: text.indexOf('&F12'),
        end: text.indexOf('&F12') + '&F12'.length,
      },
      {
        reference: { kind: 'attention', id: 'A3' },
        raw: '!A3',
        start: text.indexOf('!A3'),
        end: text.indexOf('!A3') + '!A3'.length,
      },
    ]);
  });

  test('should skip a lexical candidate the grammar then refuses', () => {
    // Act — `@a/../secret` looks like a token but escapes the session root.
    const actual = findReferences('see @a/../secret and @src/api.ts');

    // Assert
    should(actual.map(match => match.raw)).deepEqual(['@src/api.ts']);
  });

  test('should report nothing for prose without sigils', () => {
    // Act & Assert
    should(findReferences('a plain sentence with no references')).deepEqual([]);
  });
});

describe('formatReference', () => {
  test('should render every kind back to its canonical token', () => {
    // Assert
    should(formatReference({ kind: 'agent', name: 'Zelda' })).equal(':zelda');
    should(formatReference({ kind: 'file', path: 'src/api.ts' })).equal('@src/api.ts');
    should(formatReference({ kind: 'file', path: 'src/api.ts', line: 12 })).equal('@src/api.ts:12');
    should(formatReference({ kind: 'file', path: 'src/api.ts', line: 12, endLine: 20 })).equal('@src/api.ts:12-20');
    should(formatReference({ kind: 'task', id: 'f12' })).equal('&F12');
    should(formatReference({ kind: 'attention', id: 'A3' as AttentionId })).equal('!A3');
  });

  test('should refuse to render a reference the grammar would not accept', () => {
    // Assert
    should(() => formatReference({ kind: 'agent', name: '1nope' })).throw(TypeError);
    should(() => formatReference({ kind: 'file', path: '../secret' })).throw(TypeError);
    should(() => formatReference({ kind: 'task', id: 'Z9' })).throw(TypeError);
    should(() => formatReference({ kind: 'attention', id: 'A0' as AttentionId })).throw(TypeError);
  });

  test('should format a file open target from its bare location', () => {
    // Assert
    should(formatCodeReference({ path: 'src/api.ts', line: 4 })).equal('@src/api.ts:4');
  });

  test('should answer with the sigil a reader can type on either harness', () => {
    // Assert — `$name` is an accepted authored alias, never the canonical form.
    should(formatReference({ kind: 'skill', name: 'liftoff-ops' })).equal('/liftoff-ops');
    should(formatReference({ kind: 'terminal', id: '0a1b2c3d4e5f' })).equal(':term/0a1b2c3d4e5f');
    should(formatReference({ kind: 'browser', id: 'PAGE-1' })).equal(':page/PAGE-1');
  });

  test('should refuse to format an instance or skill reference it could not have parsed', () => {
    // Assert
    should(() => formatReference({ kind: 'skill', name: 'not a skill' })).throw(TypeError);
    should(() => formatReference({ kind: 'terminal', id: 'nothex' })).throw(TypeError);
    should(() => formatReference({ kind: 'browser', id: '' })).throw(TypeError);
  });
});

describe('resolveReference', () => {
  test('should prove an agent only through a live fleet answer', () => {
    // Act
    const resolved = resolveReference({ kind: 'agent', name: 'zelda' }, { agent: () => agent('session-1') });
    const unproved = resolveReference({ kind: 'agent', name: 'zelda' }, {});

    // Assert
    should(resolved).deepEqual({ kind: 'agent', daemonId, sessionId: 'session-1', name: 'zelda' });
    should(unproved).be.null();
  });

  test('should reject a fleet answer that is not a usable identity', () => {
    // Assert
    should(resolveReference({ kind: 'agent', name: 'zelda' }, { agent: () => null })).be.null();
    should(
      resolveReference(
        { kind: 'agent', name: 'zelda' },
        { agent: () => ({ daemonId, sessionId: '..', name: 'zelda' }) },
      ),
    ).be.null();
    should(
      resolveReference(
        { kind: 'agent', name: 'zelda' },
        { agent: () => ({ daemonId, sessionId: 'ok', name: '1nope' }) },
      ),
    ).be.null();
    should(
      resolveReference(
        { kind: 'agent', name: 'zelda' },
        { agent: () => ({ daemonId: '  ' as DaemonId, sessionId: 'ok', name: 'zelda' }) },
      ),
    ).be.null();
  });

  test('should replace a file candidate with the canonical path the resolver proved', () => {
    // Act
    const resolved = resolveReference(
      { kind: 'file', path: './api.ts', line: 4 },
      { file: candidate => (candidate === './api.ts' ? 'src/api.ts' : null) },
    );

    // Assert
    should(resolved).deepEqual({ kind: 'file', path: 'src/api.ts', line: 4 });
  });

  test('should leave a file candidate unproved when nothing answers for it', () => {
    // Assert
    should(resolveReference({ kind: 'file', path: 'api.ts' }, { file: () => null })).be.null();
    should(resolveReference({ kind: 'file', path: 'api.ts' }, {})).be.null();
  });

  test('should reject a resolver that answers with an unusable path', () => {
    // Assert
    should(resolveReference({ kind: 'file', path: 'api.ts' }, { file: () => '../escape' })).be.null();
  });

  test('should prove tasks and attention only on a positive answer', () => {
    // Assert
    should(resolveReference({ kind: 'task', id: 'F12' }, { task: () => true })).deepEqual({ kind: 'task', id: 'F12' });
    should(resolveReference({ kind: 'task', id: 'F12' }, { task: () => false })).be.null();
    should(resolveReference({ kind: 'attention', id: 'A3' as AttentionId }, { attention: () => true })).deepEqual({
      kind: 'attention',
      id: 'A3',
    });
    should(resolveReference({ kind: 'attention', id: 'A3' as AttentionId }, { attention: () => false })).be.null();
  });

  test('should treat a resolver that throws as no proof at all', () => {
    // Assert
    should(
      resolveReference(
        { kind: 'task', id: 'F12' },
        {
          task: () => {
            throw new Error('board offline');
          },
        },
      ),
    ).be.null();
  });
});

describe('referenceHref and parseReferenceHref', () => {
  const roundTrip: readonly ResolvedReference[] = [
    { kind: 'agent', daemonId, sessionId: 'session-1', name: 'zelda' },
    { kind: 'file', path: 'src/api.ts' },
    { kind: 'file', path: 'src/api.ts', line: 12 },
    { kind: 'file', path: 'src/api.ts', line: 12, endLine: 20 },
    { kind: 'task', id: 'F12' },
    { kind: 'attention', id: 'A3' as AttentionId },
    { kind: 'skill', name: 'summary' },
    { kind: 'terminal', id: '0a1b2c3d4e5f' },
    { kind: 'browser', id: 'PAGE-1' },
  ];

  for (const reference of roundTrip) {
    test(`should round-trip a ${reference.kind} envelope`, () => {
      // Act
      const actual = parseReferenceHref(referenceHref(reference));

      // Assert
      should(actual).deepEqual(reference);
    });
  }

  test('should carry the daemon in an agent envelope so a link cannot cross daemons', () => {
    // Act
    const href = referenceHref({ kind: 'agent', daemonId, sessionId: 'session-1', name: 'zelda' });

    // Assert
    should(href).containEql('daemon=daemon-a');
    should(parseReferenceHref(href.replace('daemon=daemon-a', 'daemon=daemon-b'))).deepEqual({
      kind: 'agent',
      daemonId: 'daemon-b',
      sessionId: 'session-1',
      name: 'zelda',
    });
  });

  test('should refuse to encode a reference that is not provable in the first place', () => {
    // Assert
    should(() => referenceHref({ kind: 'agent', daemonId, sessionId: '..', name: 'zelda' })).throw(TypeError);
    should(() => referenceHref({ kind: 'file', path: '../secret' })).throw(TypeError);
    should(() => referenceHref({ kind: 'task', id: 'Z1' })).throw(TypeError);
    should(() => referenceHref({ kind: 'attention', id: 'A0' as AttentionId })).throw(TypeError);
  });

  test('should reject anything that is not the reserved envelope', () => {
    // Assert
    should(parseReferenceHref(undefined)).be.null();
    should(parseReferenceHref('https://example.test/')).be.null();
    should(parseReferenceHref('#fy-reference?kind=pin&id=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=agent')).be.null();
  });

  test('should reject an envelope carrying extra or repeated keys', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=task&id=F12&extra=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=task&id=F12&id=F13')).be.null();
    should(parseReferenceHref('#fy-reference?kind=agent&daemon=d&id=s&name=z&name=y')).be.null();
    should(parseReferenceHref('#fy-reference?kind=attention&id=A3&id=A4')).be.null();
  });

  test('should reject a file envelope with an end line but no start line', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=file&path=src%2Fapi.ts&end=20')).be.null();
  });

  test('should reject a file envelope whose location is not a positive integer', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=file&path=src%2Fapi.ts&line=0')).be.null();
    should(parseReferenceHref('#fy-reference?kind=file&path=src%2Fapi.ts&line=2&end=zero')).be.null();
    should(parseReferenceHref('#fy-reference?kind=file&path=src%2Fapi.ts&line=20&end=2')).be.null();
  });

  test('should reject an envelope whose id is not the shape its kind demands', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=task&id=Z1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=attention&id=A0')).be.null();
    should(parseReferenceHref('#fy-reference?kind=file&path=..%2Fsecret')).be.null();
    should(parseReferenceHref('#fy-reference?kind=agent&daemon=d&id=..&name=zelda')).be.null();
  });

  test('should reject an agent envelope whose keys are present but empty', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=agent&daemon=&id=s1&name=zelda')).be.null();
    should(parseReferenceHref('#fy-reference?kind=agent&daemon=d&id=&name=zelda')).be.null();
    should(parseReferenceHref('#fy-reference?kind=agent&daemon=d&id=s1&name=')).be.null();
  });
});

describe('referenceIdentity', () => {
  test('should identify an agent by daemon and session together', () => {
    // Assert
    should(referenceIdentity({ kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' })).equal('agent:daemon-a:s1');
    should(
      referenceIdentity({ kind: 'agent', daemonId: 'daemon-b' as DaemonId, sessionId: 's1', name: 'zelda' }),
    ).not.equal('agent:daemon-a:s1');
  });

  test('should identify the other kinds by their own payload', () => {
    // Assert
    should(referenceIdentity({ kind: 'file', path: 'a.ts', line: 2, endLine: 3 })).equal('file:a.ts:2:3');
    should(referenceIdentity({ kind: 'file', path: 'a.ts' })).equal('file:a.ts::');
    should(referenceIdentity({ kind: 'task', id: 'F12' })).equal('task:F12');
    should(referenceIdentity({ kind: 'attention', id: 'A3' as AttentionId })).equal('attention:A3');
    should(referenceIdentity({ kind: 'skill', name: 'summary' })).equal('skill:summary');
    should(referenceIdentity({ kind: 'terminal', id: '0a1b2c3d4e5f' })).equal('terminal:0a1b2c3d4e5f');
    should(referenceIdentity({ kind: 'browser', id: 'PAGE-1' })).equal('browser:PAGE-1');
  });
});

describe('revalidateReference', () => {
  test('should re-prove an agent against the current fleet', () => {
    // Act
    const still = revalidateReference(
      { kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' },
      { agent: () => agent('s1') },
    );
    const gone = revalidateReference(
      { kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' },
      { agent: () => null },
    );

    // Assert
    should(still).deepEqual({ kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' });
    should(gone).be.null();
  });

  test('should refuse an agent the fleet now maps to a different session', () => {
    // Act
    const actual = revalidateReference(
      { kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' },
      { agent: () => agent('s2') },
    );

    // Assert
    should(actual).be.null();
  });

  test('should refuse an agent whose session now belongs to another daemon', () => {
    // Act
    const actual = revalidateReference(
      { kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' },
      { agent: () => ({ daemonId: 'daemon-b' as DaemonId, sessionId: 's1', name: 'zelda' }) },
    );

    // Assert
    should(actual).be.null();
  });

  test('should refuse an agent when no fleet resolver is offered', () => {
    // Assert
    should(revalidateReference({ kind: 'agent', daemonId, sessionId: 's1', name: 'zelda' }, {})).be.null();
  });

  test('should require the file resolver to answer with the identical canonical path', () => {
    // Assert
    should(revalidateReference({ kind: 'file', path: 'src/api.ts' }, { file: path => path })).deepEqual({
      kind: 'file',
      path: 'src/api.ts',
    });
    should(revalidateReference({ kind: 'file', path: 'src/api.ts' }, { file: () => 'src/other.ts' })).be.null();
  });

  test('should re-prove tasks and attention through their boards', () => {
    // Assert
    should(revalidateReference({ kind: 'task', id: 'F12' }, { task: () => true })).deepEqual({
      kind: 'task',
      id: 'F12',
    });
    should(revalidateReference({ kind: 'task', id: 'F12' }, { task: () => false })).be.null();
    should(revalidateReference({ kind: 'attention', id: 'A3' as AttentionId }, { attention: () => true })).deepEqual({
      kind: 'attention',
      id: 'A3',
    });
    should(revalidateReference({ kind: 'attention', id: 'A3' as AttentionId }, { attention: () => false })).be.null();
  });

  test('should treat a throwing resolver as no proof', () => {
    // Assert
    should(
      revalidateReference(
        { kind: 'file', path: 'a.ts' },
        {
          file: () => {
            throw new Error('daemon offline');
          },
        },
      ),
    ).be.null();
  });
});
describe('skill, terminal and browser page references', () => {
  test('should read both skill sigils as the same reference and keep the authored bytes', () => {
    // Arrange
    const text = 'Run /summary now, or $summary on Codex.';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual.map(match => match.raw)).deepEqual(['/summary', '$summary']);
    should(actual.map(match => match.reference)).deepEqual([
      { kind: 'skill', name: 'summary' },
      { kind: 'skill', name: 'summary' },
    ]);
  });

  test('should find namespaced instance tokens without stealing an agent callsign', () => {
    // Arrange — an agent really can be called `term`; only `:term/` is an instance.
    const text = 'ask :term about :term/0a1b2c3d4e5f and :page/PAGE-1.';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual.map(match => match.reference)).deepEqual([
      { kind: 'agent', name: 'term' },
      { kind: 'terminal', id: '0a1b2c3d4e5f' },
      { kind: 'browser', id: 'PAGE-1' },
    ]);
  });

  test('should leave a path-shaped or shell-shaped token alone as a lexical candidate', () => {
    // Arrange — `/home/kirin` is a path, `$HOME` is a variable. Neither is a
    // skill name, and `/tmp` is only ever a candidate: proof is what links.
    const text = 'look in /home/kirin and $HOME';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual).deepEqual([]);
  });

  test('should prove each new kind only through its own live resolver', () => {
    // Assert
    should(resolveReference({ kind: 'skill', name: 'summary' }, { skill: name => name === 'summary' })).deepEqual({
      kind: 'skill',
      name: 'summary',
    });
    should(resolveReference({ kind: 'skill', name: 'summary' }, {})).be.null();
    should(resolveReference({ kind: 'skill', name: 'summary' }, { skill: () => false })).be.null();
    should(resolveReference({ kind: 'terminal', id: '0a1b2c3d4e5f' }, { terminal: () => true })).deepEqual({
      kind: 'terminal',
      id: '0a1b2c3d4e5f',
    });
    should(resolveReference({ kind: 'terminal', id: '0a1b2c3d4e5f' }, {})).be.null();
    should(resolveReference({ kind: 'browser', id: 'PAGE-1' }, { browser: () => true })).deepEqual({
      kind: 'browser',
      id: 'PAGE-1',
    });
    should(resolveReference({ kind: 'browser', id: 'PAGE-1' }, {})).be.null();
  });

  test('should re-prove each new kind at click time', () => {
    // Assert
    should(revalidateReference({ kind: 'skill', name: 'summary' }, { skill: () => true })).deepEqual({
      kind: 'skill',
      name: 'summary',
    });
    should(revalidateReference({ kind: 'skill', name: 'summary' }, { skill: () => false })).be.null();
    should(revalidateReference({ kind: 'terminal', id: '0a1b2c3d4e5f' }, { terminal: () => true })).deepEqual({
      kind: 'terminal',
      id: '0a1b2c3d4e5f',
    });
    should(revalidateReference({ kind: 'terminal', id: '0a1b2c3d4e5f' }, { terminal: () => false })).be.null();
    should(revalidateReference({ kind: 'browser', id: 'PAGE-1' }, { browser: () => true })).deepEqual({
      kind: 'browser',
      id: 'PAGE-1',
    });
    should(revalidateReference({ kind: 'browser', id: 'PAGE-1' }, { browser: () => false })).be.null();
  });

  test('should refuse to encode an instance or skill payload the grammar rejects', () => {
    // Assert
    should(() => referenceHref({ kind: 'skill', name: 'not a skill' })).throw(TypeError);
    should(() => referenceHref({ kind: 'terminal', id: 'NOTHEX' })).throw(TypeError);
    should(() => referenceHref({ kind: 'browser', id: '.leading' })).throw(TypeError);
  });

  test('should reject an embellished or malformed envelope for every new kind', () => {
    // Assert
    should(parseReferenceHref('#fy-reference?kind=skill&name=summary&extra=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=skill&name=not%20a%20skill')).be.null();
    should(parseReferenceHref('#fy-reference?kind=skill')).be.null();
    should(parseReferenceHref('#fy-reference?kind=terminal&id=0a1b2c3d4e5f&extra=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=terminal&id=NOTHEX')).be.null();
    should(parseReferenceHref('#fy-reference?kind=terminal')).be.null();
    should(parseReferenceHref('#fy-reference?kind=browser&id=PAGE-1&extra=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=browser&id=')).be.null();
    should(parseReferenceHref('#fy-reference?kind=browser')).be.null();
  });
});

describe('remarkReferences', () => {
  /** The minimal mdast a paragraph of prose produces. */
  const paragraph = (value: string): MdTree => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  });

  const resolvers = {
    agent: () => agent('s1'),
    file: (candidate: string) => (candidate === 'src/api.ts' ? 'src/api.ts' : null),
    task: (id: string) => id === 'F12',
    attention: () => true,
  };

  test('should link only the tokens a resolver proved and leave the rest as text', () => {
    // Arrange
    const tree = paragraph('Ping :zelda about @src/api.ts:12 and @missing.ts, then &F12 or &F99.');

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    const children = kids(kids(tree)[0]);
    should(children.filter(node => node.type === 'link').map(node => node.children?.[0]?.value)).deepEqual([
      ':zelda',
      '@src/api.ts:12',
      '&F12',
    ]);
    should(children.map(node => node.value ?? '').join('')).containEql('@missing.ts');
  });

  test('should stamp each link with the reserved envelope and its origin mark', () => {
    // Arrange
    const tree = paragraph('see &F12 now');

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    const link = kids(kids(tree)[0]).find(node => node.type === 'link');
    should(link?.url).equal('#fy-reference?kind=task&id=F12');
    should(link?.title).equal('Open task &F12');
    should(link?.data?.hProperties?.['data-fy-reference']).equal('task:F12');
  });

  test('should title a file link by what opening it will do', () => {
    // Arrange
    const spans = paragraph('@src/api.ts @src/api.ts:12 @src/api.ts:12-20');

    // Act
    remarkReferences({ resolvers })(spans);

    // Assert
    should(
      kids(kids(spans)[0])
        .filter(node => node.type === 'link')
        .map(node => node.title),
    ).deepEqual(['Open @src/api.ts', 'Open @src/api.ts at line 12', 'Open @src/api.ts at lines 12–20']);
  });

  test('should title agent and attention links in their own voice', () => {
    // Arrange
    const tree = paragraph('ask :zelda about !A3');

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    should(
      kids(kids(tree)[0])
        .filter(node => node.type === 'link')
        .map(node => node.title),
    ).deepEqual(["Open :zelda's session", 'Open attention !A3']);
  });

  test('should never rewrite inside code, inline code, raw HTML or an existing link', () => {
    // Arrange
    const tree: MdTree = {
      type: 'root',
      children: [
        { type: 'code', children: [{ type: 'text', value: 'see &F12' }] },
        { type: 'inlineCode', children: [{ type: 'text', value: 'see &F12' }] },
        { type: 'html', children: [{ type: 'text', value: 'see &F12' }] },
        { type: 'link', url: 'https://example.test/', children: [{ type: 'text', value: 'see &F12' }] },
      ],
    };

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    should(kids(tree).every(node => node.children?.[0]?.type === 'text')).be.true();
  });

  test('should recurse into nested block structure', () => {
    // Arrange
    const tree: MdTree = {
      type: 'root',
      children: [
        {
          type: 'blockquote',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'nested &F12' }] }],
        },
      ],
    };

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    const nested = kids(kids(kids(tree)[0])[0]);
    should(nested.some(node => node.type === 'link')).be.true();
  });

  test('should keep the trailing text after the last link', () => {
    // Arrange
    const tree = paragraph('start &F12 end');

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    should(
      kids(kids(tree)[0])
        .map(node => node.value ?? '')
        .join(''),
    ).equal('start  end');
  });

  test('should do nothing at all when no resolvers are offered', () => {
    // Arrange
    const tree = paragraph('see &F12');
    const withoutResolvers = paragraph('see &F12');

    // Act
    remarkReferences()(tree);
    remarkReferences({})(withoutResolvers);

    // Assert
    should(tree).deepEqual(paragraph('see &F12'));
    should(withoutResolvers).deepEqual(paragraph('see &F12'));
  });

  test('should leave a node with no children untouched', () => {
    // Arrange
    const tree: MdTree = { type: 'root', children: [{ type: 'thematicBreak' }] };

    // Act
    remarkReferences({ resolvers })(tree);

    // Assert
    should(kids(tree)[0]).deepEqual({ type: 'thematicBreak' });
  });
});
