/**
 * The ONE helper behind every registry's merge-safety test ("A registry is merge-safe by construction", point 5): in a
 * throw-away git repository, branch A adds one entry to a registry and branch B adds another, each independently and in its
 * sorted place; then the two are brought together every way a person does it, and the result must be clean.
 *
 *   - `git merge` of B into A, and of A into B, exit 0;
 *   - `git rebase` of B onto A exits 0 (the replay of one add on top of the other);
 *   - each result is exactly `both` (the registry with both entries, as the generator writes it), so it holds both lines,
 *     sorted, and `--check` would accept it (`explainStale` finds nothing to say);
 *   - a TypeScript result parses.
 *
 * A registry test only builds the four texts (`base`, `a`, `b`, `both`) and calls {@link assertMergeSafe}. No network, no
 * global git config: the repository is under the OS temp folder and reads none of the user's settings.
 */
import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { explainStale } from '../lib/entry-lines.ts';

/** The files of the registry at one moment: path (relative to the repository) → text. */
export type RegistryFiles = Readonly<Record<string, string>>;

export interface TwoAdds {
  /** The registry before either entry. */
  readonly base: RegistryFiles;
  /** Branch A: the registry with entry X added in its sorted place. */
  readonly a: RegistryFiles;
  /** Branch B: the registry with entry Y added in its sorted place (not next to X). */
  readonly b: RegistryFiles;
  /** What the registry says with both X and Y, as the generator writes it. */
  readonly both: RegistryFiles;
  /** A `.gitattributes` the repository has (to prove `merge=union`); none by default. */
  readonly attributes?: string;
}

interface Git {
  (...args: string[]): { readonly ok: boolean; readonly out: string };
}

const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'registry-test',
  GIT_AUTHOR_EMAIL: 'registry-test@example.invalid',
  GIT_COMMITTER_NAME: 'registry-test',
  GIT_COMMITTER_EMAIL: 'registry-test@example.invalid',
  GIT_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
};

function repository(): { readonly dir: string; readonly git: Git; readonly dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'registry-merge-'));
  const git: Git = (...args) => {
    const run = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env: GIT_ENV,
    });
    return { ok: run.exitCode === 0, out: `${run.stdout.toString()}${run.stderr.toString()}` };
  };
  return { dir, git, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const writeAll = (dir: string, files: RegistryFiles): void => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};

const readAll = (dir: string, paths: readonly string[]): RegistryFiles =>
  Object.fromEntries(paths.map(rel => [rel, readFileSync(join(dir, rel), 'utf8')]));

/** Every outcome of one pair of independent adds. */
export interface MergeResults {
  /** `git merge b` on branch a, and `git merge a` on branch b. */
  readonly mergeAB: { readonly ok: boolean; readonly out: string; readonly files: RegistryFiles };
  readonly mergeBA: { readonly ok: boolean; readonly out: string; readonly files: RegistryFiles };
  /** `git rebase a` on branch b. */
  readonly rebase: { readonly ok: boolean; readonly out: string; readonly files: RegistryFiles };
}

/** Run the two independent adds through git and report what merge and rebase did. No assertions. */
export function runTwoAdds(spec: TwoAdds): MergeResults {
  const { dir, git, dispose } = repository();
  try {
    const paths = Object.keys(spec.both);
    git('init', '-q', '-b', 'main');
    if (spec.attributes !== undefined) writeFileSync(join(dir, '.gitattributes'), spec.attributes);
    writeAll(dir, spec.base);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'a');
    writeAll(dir, spec.a);
    git('commit', '-q', '-am', 'add x');
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'b');
    writeAll(dir, spec.b);
    git('commit', '-q', '-am', 'add y');

    // B onto A by rebase: the replay of one add on top of the other.
    git('checkout', '-q', '-b', 'rebased', 'b');
    const rebase = git('rebase', 'a');
    const rebaseResult = { ...rebase, files: rebase.ok ? readAll(dir, paths) : {} };
    if (!rebase.ok) git('rebase', '--abort');

    git('checkout', '-q', 'a');
    const ab = git('merge', '--no-edit', 'b');
    const mergeAB = { ...ab, files: ab.ok ? readAll(dir, paths) : {} };
    if (!ab.ok) git('merge', '--abort');

    git('checkout', '-q', 'b');
    const ba = git('merge', '--no-edit', 'a');
    const mergeBA = { ...ba, files: ba.ok ? readAll(dir, paths) : {} };
    return { mergeAB, mergeBA, rebase: rebaseResult };
  } finally {
    dispose();
  }
}

/** A TypeScript text that does not parse throws here: the merged registry is still a module. */
const parses = (path: string, text: string): void => {
  if (!/\.tsx?$/u.test(path)) return;
  new Bun.Transpiler({ loader: path.endsWith('x') ? 'tsx' : 'ts' }).transformSync(text);
};

/**
 * The assertion every registry test makes: merge (both ways) and rebase are clean, and each result is `both`, parses, and
 * passes the freshness comparison with nothing to say. `explainStale` is the sentence-maker `--check` prints, so "nothing to
 * say" is "`--check` accepts it".
 */
export function assertMergeSafe(spec: TwoAdds): void {
  // The two adds really are independent and really do change the registry.
  for (const [rel, base] of Object.entries(spec.base)) {
    expect(spec.a[rel]).not.toBe(base);
    expect(spec.b[rel]).not.toBe(base);
    expect(spec.a[rel]).not.toBe(spec.b[rel]);
  }
  const results = runTwoAdds(spec);
  for (const [name, result] of Object.entries(results)) {
    expect({ name, ok: result.ok, out: result.ok ? '' : result.out }).toEqual({ name, ok: true, out: '' });
    for (const [rel, want] of Object.entries(spec.both)) {
      const got = result.files[rel] ?? '';
      expect({ name, rel, text: got }).toEqual({ name, rel, text: want });
      expect(explainStale(got, want)).toEqual([]);
      parses(rel, got);
      // Both adds are in it: every line either branch has is in the result.
      for (const branch of [spec.a[rel] ?? '', spec.b[rel] ?? ''])
        for (const line of branch.split('\n')) expect(got.split('\n')).toContain(line);
    }
  }
}
