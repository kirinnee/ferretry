/**
 * The raw-YAML gate: no product code parses YAML with a reader of its own, outside the files the ledger names.
 *
 * WHY. A hand-written YAML file is the most hostile input the daemon reads: one long string aliased many times made
 * `Bun.YAML.parse` of a 256 KiB `gate.yaml` take 2.3 s and 5.4 GB at every boot (kac2 review round 8), while the
 * kernel's own reader (`packages/core/kernel/host/config/yaml-text.ts`: the size cap, the alias budget by length, no
 * YAML 1.1 tags, duplicate keys in one pass) refused the same file in one linear pass. Every daemon-side reader of
 * text a person or an agent can write must go through that one reader — or through the value the kernel already
 * checked — so a new parse of its own is refused here until somebody says, in the ledger, why it is safe.
 *
 * WHAT COUNTS, in every tracked `.ts`/`.tsx` file under `packages/` that is not a test, a fixture or test support:
 * - any use of `Bun.YAML` but its `stringify` (writing YAML reads nothing), a `YAML` taken out of `Bun`, and any
 *   `YAML.parse(`;
 * - any import or `require` of the `yaml` or `js-yaml` package (type-only imports included: they are the first step).
 *
 * THE LEDGER (`scripts/validate/raw-yaml-allowlist.txt`) is one `path  # reason` line per file that may. EXACT BOTH
 * WAYS: a file that parses and is not listed fails, and a listed file that no longer parses fails too, so the ledger
 * stays the true inventory. A line without a reason fails.
 *
 * Usage: `bun scripts/validate/no-raw-yaml.ts <repo root>`; exits 0 clean, 1 a violation, 2 a broken gate.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LEDGER = 'scripts/validate/raw-yaml-allowlist.txt';

/** A use of a YAML reader of its own, located. */
export interface RawYamlUse {
  readonly line: number;
  readonly text: string;
}

const PATTERNS: readonly RegExp[] = [
  /\bBun\s*\.\s*YAML\b(?!\s*\.\s*stringify\b)/u,
  /\bBun\s*\[\s*['"`]YAML['"`]\s*\]/u,
  /\{[^}]*\bYAML\b[^}]*\}\s*=\s*Bun\b/u,
  /\bYAML\s*\.\s*parse\s*\(/u,
  /\bfrom\s+['"](?:yaml|js-yaml)(?:\/[^'"]*)?['"]/u,
  /\bimport\s*\(\s*['"](?:yaml|js-yaml)(?:\/[^'"]*)?['"]\s*\)/u,
  /\brequire\s*\(\s*['"](?:yaml|js-yaml)(?:\/[^'"]*)?['"]\s*\)/u,
];

/** Whether a tracked path is product code this gate covers (not a test, a fixture or test support). */
export function inScope(path: string): boolean {
  if (!path.startsWith('packages/') || !/\.tsx?$/u.test(path)) return false;
  if (/\.test\.tsx?$/u.test(path)) return false;
  return !path.split('/').some(part => part === 'tests' || part === 'testing' || part === 'fixtures');
}

/** Every use in one file's text, by line: a multi-line import is found on its `} from 'yaml'` line. */
export function rawYamlUses(text: string): readonly RawYamlUse[] {
  const uses: RawYamlUse[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (PATTERNS.some(pattern => pattern.test(line))) uses.push({ line: index + 1, text: line.trim() });
  });
  return uses;
}

/** The ledger: path → reason. A line with no reason is a problem, said by its line. */
export function parseLedger(text: string): {
  readonly allowed: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
} {
  const allowed = new Map<string, string>();
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = /^(\S+)\s+#\s*(\S.*)$/u.exec(line);
    if (match === null) {
      problems.push(`${LEDGER}:${String(index + 1)}: every entry is "path  # reason"`);
      return;
    }
    const [, path, reason] = match as unknown as [string, string, string];
    if (allowed.has(path)) problems.push(`${LEDGER}:${String(index + 1)}: ${path} is listed twice`);
    allowed.set(path, reason);
  });
  return { allowed, problems };
}

/** Every finding over the given files and ledger. Pure: the tests drive it with planted files. */
export function findings(
  files: readonly { readonly path: string; readonly text: string }[],
  ledgerText: string,
): readonly string[] {
  const { allowed, problems } = parseLedger(ledgerText);
  const found: string[] = [...problems];
  const using = new Set<string>();
  for (const file of files) {
    if (!inScope(file.path)) continue;
    const uses = rawYamlUses(file.text);
    if (uses.length === 0) continue;
    using.add(file.path);
    if (allowed.has(file.path)) continue;
    for (const use of uses)
      found.push(
        `${file.path}:${String(use.line)}: a YAML reader of its own (${use.text}). Read the text with the kernel's ` +
          'bounded reader (or the value the kernel checked), or list the file in the ledger with why it is safe',
      );
  }
  for (const path of allowed.keys())
    if (!using.has(path)) found.push(`${LEDGER}: ${path} no longer parses YAML itself; remove its line`);
  return found;
}

function main(root: string): number {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) {
    console.error('❌ git ls-files failed');
    return 2;
  }
  let ledgerText: string;
  try {
    ledgerText = readFileSync(resolve(root, LEDGER), 'utf8');
  } catch {
    console.error(`❌ missing ledger: ${LEDGER}`);
    return 2;
  }
  const files = listed.stdout
    .split('\0')
    .filter(path => path !== '' && inScope(path))
    .flatMap(path => {
      try {
        return [{ path, text: readFileSync(resolve(root, path), 'utf8') }];
      } catch {
        // Tracked but deleted in the working tree: nothing to read.
        return [];
      }
    });
  const found = findings(files, ledgerText);
  for (const finding of found) console.error(`❌ ${finding}`);
  return found.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(resolve(process.argv[2] ?? '.')));
