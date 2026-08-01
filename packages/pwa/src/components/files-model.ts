import type { FsEntry } from './files-api.ts';

export type StatusTone = 'ok' | 'warn' | 'err' | 'accent' | 'neutral';
export interface StatusChip {
  code: string;
  label: string;
  tone: StatusTone;
  detail?: string;
}

export const normalizeRel = (input: string | null | undefined): string => {
  if (!input) return '';
  const out: string[] = [];
  for (const part of String(input).split(/[/\\]/)) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};
export const joinRel = (dir: string, name: string): string =>
  normalizeRel(`${normalizeRel(dir)}${dir && name ? '/' : ''}${name ?? ''}`);

const hasUnsupportedNameChar = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
export const UNOPENABLE_NAME_REASON =
  'name cannot be opened by this viewer — it uses a character the daemon’s path grammar refuses';
export const isOpenableName = (name: string | null | undefined): boolean => {
  const value = name ?? '';
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !hasUnsupportedNameChar(value);
};
export const isOpenablePath = (rel: string | null | undefined): boolean =>
  !!rel && rel.split('/').every(isOpenableName);
export const entryRefusal = (entry: FsEntry): string | null => {
  if (entry.denied) return 'not served — denylisted (secrets policy)';
  if (!isOpenableName(entry.name)) return UNOPENABLE_NAME_REASON;
  if (entry.escapes) return 'symlink leaves this session’s folder — not served';
  if (entry.type === 'symlink') return 'symlink — listed only, not served';
  if (entry.ignored) return 'gitignored — content is not served';
  return null;
};
export const sortFsEntries = (entries: readonly FsEntry[] | undefined | null): FsEntry[] =>
  [...(entries ?? [])].sort(
    (a, b) =>
      (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
export const parentRel = (rel: string): string => {
  const norm = normalizeRel(rel);
  return norm.slice(0, Math.max(0, norm.lastIndexOf('/')));
};
export const baseName = (rel: string): string => {
  const norm = normalizeRel(rel);
  return norm.slice(norm.lastIndexOf('/') + 1);
};
export const dirPrefix = (rel: string): string => {
  const parent = parentRel(rel);
  return parent ? `${parent}/` : '';
};
export interface Crumb {
  label: string;
  path: string;
}
export const crumbs = (rel: string, rootLabel = 'root'): Crumb[] => {
  const result: Crumb[] = [{ label: rootLabel, path: '' }];
  let path = '';
  for (const segment of normalizeRel(rel).split('/'))
    if (segment) {
      path = path ? `${path}/${segment}` : segment;
      result.push({ label: segment, path });
    }
  return result;
};
export const isMarkdownPath = (rel: string): boolean =>
  ['md', 'mdx', 'markdown'].includes((baseName(rel).split('.').pop() ?? '').toLowerCase());

const highlightTagOrNewline = /<span\b[^>]*>|<\/span>|\r?\n/giu;
export const splitHighlightedLines = (html: string): string[] => {
  const lines: string[] = [],
    open: string[] = [];
  let line = '',
    cursor = 0;
  for (const match of html.matchAll(highlightTagOrNewline)) {
    const index = match.index;
    if (index === undefined) continue;
    const token = match[0];
    line += html.slice(cursor, index);
    cursor = index + token.length;
    if (token === '\n' || token === '\r\n') {
      lines.push(`${line}${'</span>'.repeat(open.length)}`);
      line = open.join('');
    } else {
      line += token;
      if (/^<span\b/iu.test(token)) open.push(token);
      else if (open.length) open.pop();
    }
  }
  lines.push(line + html.slice(cursor));
  return lines;
};

const words: Record<string, StatusChip> = {
  modified: { code: 'M', label: 'Modified', tone: 'warn' },
  added: { code: 'A', label: 'Added', tone: 'ok' },
  new: { code: 'A', label: 'Added', tone: 'ok' },
  deleted: { code: 'D', label: 'Deleted', tone: 'err' },
  removed: { code: 'D', label: 'Deleted', tone: 'err' },
  renamed: { code: 'R', label: 'Renamed', tone: 'accent' },
  copied: { code: 'C', label: 'Copied', tone: 'accent' },
  untracked: { code: '?', label: 'Untracked', tone: 'accent' },
  ignored: { code: '!', label: 'Ignored', tone: 'neutral' },
  conflicted: { code: 'U', label: 'Conflicted', tone: 'err' },
  unmerged: { code: 'U', label: 'Conflicted', tone: 'err' },
  typechange: { code: 'T', label: 'Type changed', tone: 'warn' },
};
const letters: Record<string, { label: string; tone: StatusTone }> = {
  M: { label: 'Modified', tone: 'warn' },
  A: { label: 'Added', tone: 'ok' },
  D: { label: 'Deleted', tone: 'err' },
  R: { label: 'Renamed', tone: 'accent' },
  C: { label: 'Copied', tone: 'accent' },
  T: { label: 'Type changed', tone: 'warn' },
  U: { label: 'Conflicted', tone: 'err' },
};
export const statusChip = (raw: string | undefined | null): StatusChip => {
  const value = (raw ?? '').trim();
  if (!value) return { code: '•', label: 'Changed', tone: 'neutral' };
  const word = words[value.toLowerCase()];
  if (word) return word;
  const original = raw ?? '';
  const xy = original.length >= 2 ? original.slice(0, 2) : value.padEnd(2, ' ');
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  if (xy === '??') return { code: '?', label: 'Untracked', tone: 'accent' };
  if (xy === '!!') return { code: '!', label: 'Ignored', tone: 'neutral' };
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD')
    return { code: 'U', label: 'Conflicted', tone: 'err', detail: 'unmerged' };
  const staged = x !== ' ' && x !== '?',
    unstaged = y !== ' ' && y !== '?',
    primary = letters[unstaged ? y : x] ?? letters[x];
  const detail = staged && unstaged ? 'staged and unstaged' : staged ? 'staged' : unstaged ? 'unstaged' : undefined;
  return primary
    ? { code: unstaged ? y : x, label: primary.label, tone: primary.tone, ...(detail ? { detail } : {}) }
    : { code: value.replace(/\s+/g, '') || '•', label: 'Changed', tone: 'neutral', ...(detail ? { detail } : {}) };
};
export const changeRowLabel = (path: string, chip: StatusChip, from?: string): string =>
  `${chip.label}${chip.detail ? ` (${chip.detail})` : ''}: ${path}${from ? ` from ${from}` : ''}. Open diff`;

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'nonl';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}
export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
  total: number;
  binary: boolean;
}
export const MAX_DIFF_LINES = 4000;
const metaPrefixes = [
  'diff --git',
  'diff --no-index',
  'index ',
  'old mode',
  'new mode',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'GIT binary patch',
];
export const parseUnifiedDiff = (text: string, maxLines = MAX_DIFF_LINES): ParsedDiff => {
  const raw = text.replace(/\n$/, '') ? text.replace(/\n$/, '').split('\n') : [];
  const lines: DiffLine[] = [];
  let added = 0,
    removed = 0,
    binary = false,
    oldNo = 0,
    newNo = 0,
    inHunk = false,
    oldLeft = 0,
    newLeft = 0;
  for (const value of raw) {
    let line: DiffLine;
    if (value.startsWith('@@')) {
      const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(value);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[3]) : 0;
      oldLeft = match ? (match[2] === undefined ? 1 : Number(match[2])) : Infinity;
      newLeft = match ? (match[4] === undefined ? 1 : Number(match[4])) : Infinity;
      inHunk = true;
      line = { kind: 'hunk', text: value };
    } else if (metaPrefixes.some(prefix => value.startsWith(prefix))) {
      if (value.startsWith('diff ')) inHunk = false;
      if (value.startsWith('GIT binary patch')) binary = true;
      line = { kind: 'meta', text: value };
    } else if (!inHunk && (value.startsWith('---') || value.startsWith('+++'))) line = { kind: 'meta', text: value };
    else if (value.startsWith('Binary file')) {
      binary = true;
      line = { kind: 'meta', text: value };
    } else if (value.startsWith('\\')) line = { kind: 'nonl', text: value };
    else if (value.startsWith('+')) {
      added++;
      newLeft--;
      line = { kind: 'add', text: value.slice(1), ...(newNo ? { newNo } : {}) };
      if (newNo) newNo++;
    } else if (value.startsWith('-')) {
      removed++;
      oldLeft--;
      line = { kind: 'del', text: value.slice(1), ...(oldNo ? { oldNo } : {}) };
      if (oldNo) oldNo++;
    } else {
      oldLeft--;
      newLeft--;
      line = {
        kind: 'ctx',
        text: value.startsWith(' ') ? value.slice(1) : value,
        ...(oldNo ? { oldNo } : {}),
        ...(newNo ? { newNo } : {}),
      };
      if (oldNo) oldNo++;
      if (newNo) newNo++;
    }
    if (inHunk && oldLeft <= 0 && newLeft <= 0) inHunk = false;
    lines.push(line);
  }
  return {
    lines: lines.length > maxLines ? lines.slice(0, maxLines) : lines,
    added,
    removed,
    truncated: lines.length > maxLines,
    total: lines.length,
    binary,
  };
};
const plumbingMeta = /^(?:diff --git |diff --no-index |index [0-9a-f]{4,}|--- |\+\+\+ )/;
export const isPlumbingMeta = (line: DiffLine): boolean => line.kind === 'meta' && plumbingMeta.test(line.text);
export const renderableDiffLines = (parsed: ParsedDiff): DiffLine[] =>
  parsed.lines.filter(line => !isPlumbingMeta(line));
export const formatBytes = (size: number | undefined | null): string => {
  if (size == null || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
export const countLabel = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;
