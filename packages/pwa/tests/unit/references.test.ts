import { describe, test } from 'bun:test';
import type { AttentionId } from '@ferretry/protocol';
import should from 'should';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  acceptsDirectReferenceQuery,
  DIRECT_REFERENCE_SIGILS,
  findReferences,
  formatCodeReference,
  formatReference,
  isReferenceLeftBoundary,
  parseReferenceHref,
  parseReferenceToken,
  REFERENCE_CLOSED_ATTRIBUTE,
  type Reference,
  type ResolvedAgent,
  type ResolvedReference,
  type ResolvedSurfaceReference,
  referenceHref,
  referenceIdentity,
  remarkReferences,
  resolveReference,
  revalidateReference,
  type SurfaceProof,
  type SurfaceReference,
  surfaceReferenceClosed,
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
  });

  test('should refuse to format an instance or skill reference it could not have parsed', () => {
    // Assert
    should(() => formatReference({ kind: 'skill', name: 'not a skill' })).throw(TypeError);
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
describe('skill references', () => {
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

  test('should leave a path-shaped or shell-shaped token alone entirely', () => {
    // Arrange — `/home/kirin` is a path and `$HOME` is a variable. Neither is a
    // skill name, so neither is even a candidate.
    const text = 'look in /home/kirin and $HOME';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual).deepEqual([]);
  });

  test("should prove a skill only through this session's own catalog", () => {
    // Assert
    should(resolveReference({ kind: 'skill', name: 'summary' }, { skill: name => name === 'summary' })).deepEqual({
      kind: 'skill',
      name: 'summary',
    });
    should(resolveReference({ kind: 'skill', name: 'summary' }, {})).be.null();
    should(resolveReference({ kind: 'skill', name: 'summary' }, { skill: () => false })).be.null();
  });

  test('should re-prove a skill at click time', () => {
    // Assert
    should(revalidateReference({ kind: 'skill', name: 'summary' }, { skill: () => true })).deepEqual({
      kind: 'skill',
      name: 'summary',
    });
    should(revalidateReference({ kind: 'skill', name: 'summary' }, { skill: () => false })).be.null();
  });

  test('should refuse to encode or decode a skill payload the grammar rejects', () => {
    // Assert
    should(() => referenceHref({ kind: 'skill', name: 'not a skill' })).throw(TypeError);
    should(parseReferenceHref('#fy-reference?kind=skill&name=summary&extra=1')).be.null();
    should(parseReferenceHref('#fy-reference?kind=skill&name=not%20a%20skill')).be.null();
    should(parseReferenceHref('#fy-reference?kind=skill')).be.null();
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

describe('surface references', () => {
  const sessionId = 'sess-1';
  const openTerminal = (key: string): SurfaceProof => ({
    state: 'open',
    daemonId,
    sessionId,
    surface: 'terminal',
    key,
  });
  const resolvers = {
    surface: (lookup: SurfaceReference) =>
      lookup.key === 'live' ? openTerminal('live') : { state: 'closed' as const },
  };
  const resolved: ResolvedSurfaceReference = {
    kind: 'surface',
    daemonId,
    sessionId,
    surface: 'terminal',
    key: 'ab12cd34ef56',
  };

  describe('the grammar', () => {
    test('should parse a canonical terminal token', () => {
      // Assert
      should(parseReferenceToken('%terminal:ab12cd34ef56')).deepEqual({
        kind: 'surface',
        surface: 'terminal',
        key: 'ab12cd34ef56',
      });
    });

    test('should parse a browser page token, so a page slots in unchanged', () => {
      // Assert
      should(parseReferenceToken('%browser:page-7')).deepEqual({
        kind: 'surface',
        surface: 'browser',
        key: 'page-7',
      });
    });

    test('should case-fold the surface kind but never the owner-issued key', () => {
      // Assert
      should(parseReferenceToken('%TERMINAL:AB12')).deepEqual({
        kind: 'surface',
        surface: 'terminal',
        key: 'AB12',
      });
    });

    test('should refuse a surface kind this product cannot address', () => {
      // Assert
      should(parseReferenceToken('%editor:1')).be.null();
    });

    test('should refuse a keyless or dotted token', () => {
      // Assert
      should(parseReferenceToken('%terminal:')).be.null();
      should(parseReferenceToken('%terminal:ab.cd')).be.null();
      should(parseReferenceToken('%terminal:-lead')).be.null();
    });

    test('should find a surface token in prose without swallowing the sentence', () => {
      // Act
      const found = findReferences('drive %terminal:ab12cd34ef56, then stop.');

      // Assert
      should(found.map(match => match.raw)).deepEqual(['%terminal:ab12cd34ef56']);
    });

    test('should never read a percentage as a surface reference', () => {
      // Assert
      should(findReferences('cpu hit 50% and 3%terminal:x stayed prose')).deepEqual([]);
    });

    test('should format a surface reference back to its authored token', () => {
      // Assert
      should(formatReference({ kind: 'surface', surface: 'terminal', key: 'ab12' })).equal('%terminal:ab12');
    });

    test('should refuse to format a surface reference the grammar rejects', () => {
      // Assert
      should(() => formatReference({ kind: 'surface', surface: 'terminal', key: 'bad key' })).throw(
        'invalid surface reference',
      );
      should(() => formatReference({ kind: 'surface', surface: 'editor' as 'terminal', key: 'ok' })).throw(
        'invalid surface reference',
      );
    });
  });

  describe('proof', () => {
    test('should resolve a live surface stamped with its daemon and session', () => {
      // Act
      const actual = resolveReference({ kind: 'surface', surface: 'terminal', key: 'live' }, resolvers);

      // Assert
      should(actual).deepEqual({ kind: 'surface', daemonId, sessionId, surface: 'terminal', key: 'live' });
    });

    test('should refuse a surface with no resolver at all', () => {
      // Assert
      should(resolveReference({ kind: 'surface', surface: 'terminal', key: 'live' }, {})).be.null();
    });

    test('should refuse a closed surface as a destination', () => {
      // Assert
      should(resolveReference({ kind: 'surface', surface: 'terminal', key: 'gone' }, resolvers)).be.null();
    });

    test('should refuse a resolver that answers with a different surface than the one asked for', () => {
      // Arrange — a substituted answer would open a real but WRONG terminal.
      const substitute = { surface: () => openTerminal('another') };

      // Assert
      should(resolveReference({ kind: 'surface', surface: 'terminal', key: 'live' }, substitute)).be.null();
      should(
        resolveReference({ kind: 'surface', surface: 'browser', key: 'live' }, { surface: () => openTerminal('live') }),
      ).be.null();
    });

    test('should refuse an answer carrying no usable daemon or session', () => {
      // Assert
      should(
        resolveReference(
          { kind: 'surface', surface: 'terminal', key: 'live' },
          { surface: () => ({ ...openTerminal('live'), daemonId: '  ' as DaemonId }) },
        ),
      ).be.null();
      should(
        resolveReference(
          { kind: 'surface', surface: 'terminal', key: 'live' },
          { surface: () => ({ ...openTerminal('live'), sessionId: '..' }) },
        ),
      ).be.null();
    });

    test('should refuse a token the grammar rejects even with a willing resolver', () => {
      // Assert
      should(
        resolveReference(
          { kind: 'surface', surface: 'terminal', key: 'bad key' },
          { surface: () => openTerminal('bad key') },
        ),
      ).be.null();
    });

    test('should report a proved-closed surface as closed and nothing else', () => {
      // Assert
      should(surfaceReferenceClosed({ kind: 'surface', surface: 'terminal', key: 'gone' }, resolvers)).be.true();
      should(surfaceReferenceClosed({ kind: 'surface', surface: 'terminal', key: 'live' }, resolvers)).be.false();
      should(surfaceReferenceClosed({ kind: 'surface', surface: 'terminal', key: 'gone' }, {})).be.false();
      should(surfaceReferenceClosed({ kind: 'surface', surface: 'terminal', key: 'bad key' }, resolvers)).be.false();
    });

    test('should read a throwing resolver as no evidence, never as a tombstone', () => {
      // Arrange
      const broken = {
        surface: () => {
          throw new Error('daemon unreachable');
        },
      };

      // Assert
      should(surfaceReferenceClosed({ kind: 'surface', surface: 'terminal', key: 'gone' }, broken)).be.false();
      should(resolveReference({ kind: 'surface', surface: 'terminal', key: 'gone' }, broken)).be.null();
    });
  });

  describe('the envelope', () => {
    test('should carry the daemon, the session, the kind and the key', () => {
      // Act
      const href = referenceHref(resolved);

      // Assert
      should(parseReferenceHref(href)).deepEqual(resolved);
    });

    test('should refuse to encode a resolved surface the grammar rejects', () => {
      // Assert
      should(() => referenceHref({ ...resolved, key: 'bad key' })).throw('invalid resolved surface reference');
    });

    test('should refuse an embellished, short or unknown-kind envelope', () => {
      // Assert
      should(parseReferenceHref(`${referenceHref(resolved)}&extra=1`)).be.null();
      should(
        parseReferenceHref('#fy-reference?kind=surface&daemon=daemon-a&session=sess-1&surface=terminal'),
      ).be.null();
      should(
        parseReferenceHref('#fy-reference?kind=surface&daemon=daemon-a&session=sess-1&surface=editor&key=1'),
      ).be.null();
    });

    test('should identify a surface by facts a rename cannot move', () => {
      // Assert
      should(referenceIdentity(resolved)).equal('surface:daemon-a:sess-1:terminal:ab12cd34ef56');
    });
  });

  describe('re-proof at click time', () => {
    const live: ResolvedSurfaceReference = { ...resolved, key: 'live' };

    test('should re-prove a surface that is still open', () => {
      // Assert
      should(revalidateReference(live, resolvers)).deepEqual(live);
    });

    test('should refuse a surface that closed while the transcript sat on screen', () => {
      // Assert
      should(revalidateReference({ ...resolved, key: 'gone' }, resolvers)).be.null();
    });

    test('should never re-prove across a daemon or a session boundary', () => {
      // Assert — the resolver in hand belongs to (daemon-a, sess-1).
      should(revalidateReference({ ...live, daemonId: 'daemon-b' as DaemonId }, resolvers)).be.null();
      should(revalidateReference({ ...live, sessionId: 'sess-2' }, resolvers)).be.null();
      should(revalidateReference(live, {})).be.null();
    });
  });

  describe('the transform', () => {
    const paragraph = (value: string): MdTree => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
    });

    test('should link a live surface and title it for the reader', () => {
      // Arrange
      const tree = paragraph('watch %terminal:live now');

      // Act
      remarkReferences({ resolvers })(tree);

      // Assert
      const link = kids(kids(tree)[0])[1];
      should(link?.type).equal('link');
      should(link?.title).equal("Open this session's terminal live");
      should(link?.data?.hProperties?.['data-fy-reference']).equal('surface:daemon-a:sess-1:terminal:live');
    });

    test('should tombstone a surface the owner proved gone, keeping the surrounding prose', () => {
      // Arrange
      const tree = paragraph('use %terminal:gone please');

      // Act
      remarkReferences({ resolvers })(tree);

      // Assert
      const children = kids(kids(tree)[0]);
      should(children.map(node => node.type)).deepEqual(['text', 'delete', 'text']);
      should(children[0]?.value).equal('use ');
      should(children[2]?.value).equal(' please');
      should(kids(children[1])[0]?.value).equal('%terminal:gone');
      should(children[1]?.data?.hProperties?.[REFERENCE_CLOSED_ATTRIBUTE]).equal('terminal:gone');
      should(children[1]?.data?.hProperties?.title).equal('This terminal (gone) is no longer open in this session');
    });

    test('should leave an unproved surface as plain prose rather than announcing a death', () => {
      // Arrange
      const tree = paragraph('maybe %terminal:live');

      // Act — no surface resolver: the daemon was never asked.
      remarkReferences({ resolvers: {} })(tree);

      // Assert
      should(tree).deepEqual(paragraph('maybe %terminal:live'));
    });
  });
});

describe('the composer-facing half of the grammar', () => {
  describe('isReferenceLeftBoundary', () => {
    test('should answer for the same characters the scanner itself accepts', () => {
      // Act & Assert — nothing before a token is the `^` half of the rule.
      should(isReferenceLeftBoundary(undefined)).be.true();
      for (const previous of [' ', '\n', '\t', '(', '[', '{', '"', "'", '`', '<', '>', '=', '—', '–'])
        should(isReferenceLeftBoundary(previous)).be.true();
      for (const previous of ['a', 'Z', '9', '_', '-', '.', '/', ':', '&', '!', '$', '@', '%', ',', ';'])
        should(isReferenceLeftBoundary(previous)).be.false();
    });

    test('should agree with what findReferences actually links', () => {
      // Arrange — the decision exists so a picker cannot open where the scanner
      // refuses, so the two are asserted against each other rather than apart.
      const prefixes = [' ', '(', 'x', ':', '.', ''];

      for (const prefix of prefixes) {
        // Act
        const linked = findReferences(`${prefix}:zelda`).length === 1;

        // Assert
        should(linked).equal(isReferenceLeftBoundary(prefix === '' ? undefined : prefix));
      }
    });
  });

  describe('acceptsDirectReferenceQuery', () => {
    test('should name exactly the four sigils that open a family of their own', () => {
      // Assert — `@`, `%` and `/` are composer triggers, not token prefixes.
      should([...DIRECT_REFERENCE_SIGILS]).deepEqual([':', '&', '!', '$']);
    });

    test('should accept every prefix of a complete token, and the bare sigil', () => {
      // Arrange — a picker decides on half-typed bytes, so each proper prefix of
      // a real token has to stay viable all the way up to the token itself.
      const complete: readonly [(typeof DIRECT_REFERENCE_SIGILS)[number], string][] = [
        [':', 'zelda'],
        ['&', 'F12'],
        ['!', 'A31'],
        ['$', 'summary'],
      ];

      for (const [sigil, body] of complete)
        for (let length = 0; length <= body.length; length++) {
          // Act & Assert
          should(acceptsDirectReferenceQuery(sigil, body.slice(0, length))).be.true();
          // And the completed token really is one this grammar parses.
          should(parseReferenceToken(`${sigil}${body}`)).not.be.null();
        }
    });

    test('should refuse a query no token of that family could ever start with', () => {
      // Act & Assert — `$HOME` is the reason skills are lowercase-only, and
      // `!a3` is the reason attention is not case-folded.
      should(acceptsDirectReferenceQuery('$', 'HOME')).be.false();
      should(acceptsDirectReferenceQuery('$', 'PATH')).be.false();
      should(acceptsDirectReferenceQuery('!', 'a3')).be.false();
      should(acceptsDirectReferenceQuery('!', 'B3')).be.false();
      should(acceptsDirectReferenceQuery('!', 'A0')).be.false();
      should(acceptsDirectReferenceQuery('&', 'x1')).be.false();
      should(acceptsDirectReferenceQuery('&', 'F1234567890')).be.false();
      should(acceptsDirectReferenceQuery(':', '1zelda')).be.false();
      should(acceptsDirectReferenceQuery(':', 'a'.repeat(33))).be.false();
    });

    test('should fold case exactly where the token grammar folds it', () => {
      // Act & Assert — agents and tasks are case-insensitive; attention and
      // skills are not, and a picker must not offer what the parser refuses.
      should(acceptsDirectReferenceQuery(':', 'Zelda')).be.true();
      should(acceptsDirectReferenceQuery('&', 'f12')).be.true();
      should(acceptsDirectReferenceQuery('$', 'Summary')).be.false();
      should(parseReferenceToken(':Zelda')).deepEqual({ kind: 'agent', name: 'zelda' });
      should(parseReferenceToken('&f12')).deepEqual({ kind: 'task', id: 'F12' });
      should(parseReferenceToken('$Summary')).be.null();
    });
  });
});
