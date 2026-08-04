/**
 * Pure tool-call parsing — the reading the transcript's tool group is built on.
 *
 * Ported from kteam's `src/lib/tool-extract.ts`. It stays a pure module so the
 * presentation can change without touching the heuristics for Claude's object
 * inputs and Codex's string inputs (`exec` / `apply_patch`), which were tuned
 * against real transcripts and are expensive to rediscover.
 */

/** A tool invocation as it arrives on the wire. Every field is optional: this
 *  is agent-authored data, not a daemon-owned contract. */
export interface ToolUseData {
  readonly toolUseId?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly id?: string;
}

/** A tool result as it arrives on the wire. */
export interface ToolResultData {
  readonly toolUseId?: string;
  readonly content?: unknown;
  readonly text?: string;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface ToolResultImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly data: string;
}

export type ToolKind = 'bash' | 'read' | 'write' | 'edit' | 'patch' | 'search' | 'plan' | 'wait' | 'generic';

export interface ExtractedTool {
  /** Short verb shown as the group chip, e.g. "Bash", "Edit", "Read". */
  readonly verb: string;
  /** The informative headline (command / file path). */
  readonly headline: string;
  /** Muted suffix (description / patch summary). */
  readonly detail?: string;
  /** Expanded body (the full input). */
  readonly bodyLines: readonly string[];
  readonly kind: ToolKind;
  readonly isExec: boolean;
  /** File this tool touched, when applicable — used to highlight the result or
   *  body by extension. */
  readonly filePath?: string;
}

const decodeEscapes = (value: string): string =>
  value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\$/g, '$');

const extractExecCommand = (input: unknown): { readonly command: string } | null => {
  if (typeof input !== 'string') return null;
  const quoted = input.match(/cmd\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (quoted?.[1]) return { command: decodeEscapes(quoted[1]) };
  const backticked = input.match(/cmd\s*:\s*`([^`]+)`/);
  if (backticked?.[1]) return { command: backticked[1] };
  return null;
};

const isApplyPatch = (input: unknown, name?: string): boolean =>
  name === 'apply_patch' || (typeof input === 'string' && /Begin Patch/.test(input));

const inputAsObject = (input: unknown): Record<string, unknown> | null =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;

const firstString = (object: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

/** The first line of a blob, trimmed — a headline never wraps. */
export const firstLine = (value: string): string => {
  const breakAt = value.indexOf('\n');
  return (breakAt === -1 ? value : value.slice(0, breakAt)).trim();
};

const stringifySafe = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Codex exec results start with a wall-time prefix. Splitting it off gives the
 *  status line something to say and keeps the output body clean. */
export const parseExecOutput = (text: string): { readonly wallTime?: string; readonly cleanText: string } => {
  const prefix = text.match(/^Script completed\nWall time ([0-9.]+ seconds)\nOutput:\n?/);
  if (!prefix) return { cleanText: text };
  return {
    wallTime: prefix[1],
    cleanText: text.replace(/^Script completed\nWall time [0-9.]+ seconds\nOutput:\n?/, ''),
  };
};

const pickPatchSummary = (patch: string): string | undefined => {
  const header = patch.match(/^\*\*\* (Add|Update|Delete) File:\s*(\S+)/m);
  return header ? `${header[1]} ${header[2]}` : undefined;
};

const baseName = (path: string): string => {
  const clean = (path.split(/[?#]/)[0] ?? path).replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? path) : path;
};

const capitalize = (value: string): string => (value ? value[0]!.toUpperCase() + value.slice(1) : value);

/** Both patch shapes — a bare Codex patch body and a named patch tool — read
 *  the same once the body is in hand. */
const patchSummary = (patch: string): ExtractedTool => ({
  verb: 'Patch',
  headline: pickPatchSummary(patch) ?? 'apply_patch',
  bodyLines: patch.split('\n'),
  kind: 'patch',
  isExec: false,
});

/** The one reading of a tool call: its verb, its headline, and the body an
 *  expanded row shows. Never throws — an unrecognised tool still reads as
 *  something a human can scan. */
export const extractToolSummary = (name: string | undefined, input: unknown): ExtractedTool => {
  const lower = (name ?? '').toLowerCase();

  if (name === 'exec' && typeof input === 'string') {
    const parsed = extractExecCommand(input);
    if (parsed)
      return {
        verb: 'Bash',
        headline: firstLine(parsed.command),
        bodyLines: parsed.command.split('\n'),
        kind: 'bash',
        isExec: true,
      };
  }

  if (isApplyPatch(input, name)) {
    return patchSummary(typeof input === 'string' ? input : '');
  }

  if (lower === 'bash') {
    const object = inputAsObject(input);
    if (object) {
      const command = firstString(object, ['command']);
      return {
        verb: 'Bash',
        headline: command ? firstLine(command) : 'Bash',
        detail: firstString(object, ['description']),
        bodyLines: command ? command.split('\n') : [],
        kind: 'bash',
        isExec: true,
      };
    }
  }

  if (lower === 'read') {
    const object = inputAsObject(input);
    const file = object ? firstString(object, FILE_KEYS) : undefined;
    return {
      verb: 'Read',
      headline: file ? baseName(file) : 'Read',
      detail: file,
      bodyLines: file ? [file] : [],
      kind: 'read',
      isExec: false,
      filePath: file,
    };
  }

  if (lower === 'write') {
    const object = inputAsObject(input);
    const file = object ? firstString(object, FILE_KEYS) : undefined;
    const content = object?.content;
    return {
      verb: 'Write',
      headline: file ? baseName(file) : 'Write',
      detail: file,
      bodyLines: file ? (content === undefined ? [file] : [file, '', ...stringifySafe(content).split('\n')]) : [],
      kind: 'write',
      isExec: false,
      filePath: file,
    };
  }

  if (lower === 'edit' || lower === 'multi_edit' || lower === 'multiedit' || lower === 'edit_file') {
    const object = inputAsObject(input);
    const file = object ? firstString(object, FILE_KEYS) : undefined;
    const before = object ? firstString(object, ['old_string', 'oldString', 'old']) : undefined;
    const after = object ? firstString(object, ['new_string', 'newString', 'new', 'replace']) : undefined;
    const lines: string[] = [];
    if (before) lines.push('- old', ...before.split('\n'));
    if (after) lines.push('+ new', ...after.split('\n'));
    return {
      verb: 'Edit',
      headline: file ? baseName(file) : 'Edit',
      detail: file,
      bodyLines: lines,
      kind: 'edit',
      isExec: false,
      filePath: file,
    };
  }

  if (lower === 'apply_patch' || lower === 'patch' || lower === 'notebookedit') {
    const declared = firstString(inputAsObject(input) ?? {}, ['patch', 'input']);
    return patchSummary(declared ?? (typeof input === 'string' ? input : ''));
  }

  if (name === 'wait') {
    const object = inputAsObject(input);
    const cell = object ? (firstString(object, ['cell_id']) ?? String(object['cell_id'] ?? '')) : '';
    return {
      verb: 'Wait',
      headline: cell ? `cell ${cell}` : 'wait',
      bodyLines: object ? [JSON.stringify(object, null, 2)] : [],
      kind: 'wait',
      isExec: false,
    };
  }

  if (name === 'update_plan' || (typeof input === 'string' && /update_plan/.test(input))) {
    return {
      verb: 'Plan',
      headline: 'update_plan',
      bodyLines: typeof input === 'string' ? [firstLine(input)] : ['plan update'],
      kind: 'plan',
      isExec: false,
    };
  }

  if (lower === 'grep' || lower === 'glob' || lower === 'search' || lower === 'websearch' || lower === 'webfetch') {
    const object = inputAsObject(input);
    const query = object ? firstString(object, ['pattern', 'query', 'url', 'prompt']) : undefined;
    return {
      verb: capitalize(name ?? 'search'),
      headline: query ?? name ?? 'search',
      bodyLines: object ? [JSON.stringify(object, null, 2)] : [],
      kind: 'search',
      isExec: false,
    };
  }

  const object = inputAsObject(input);
  if (object) {
    const value = firstString(object, GENERIC_KEYS);
    return {
      verb: capitalize(name ?? 'tool'),
      headline: value ? firstLine(value) : (name ?? 'tool'),
      bodyLines: [JSON.stringify(object, null, 2)],
      kind: 'generic',
      isExec: false,
    };
  }

  if (typeof input === 'string') {
    return {
      verb: capitalize(name ?? 'tool'),
      headline: firstLine(input),
      bodyLines: input.split('\n').slice(0, GENERIC_BODY_LINES),
      kind: 'generic',
      isExec: false,
    };
  }

  return { verb: capitalize(name ?? 'tool'), headline: name ?? 'tool', bodyLines: [], kind: 'generic', isExec: false };
};

const FILE_KEYS = ['file_path', 'filePath', 'path'] as const;

const GENERIC_KEYS = [
  'command',
  'file_path',
  'filePath',
  'path',
  'prompt',
  'text',
  'url',
  'query',
  'name',
  'description',
] as const;

/** An unrecognised string input is a blob of unknown size; the expanded row is
 *  a preview of it, not a viewer for it. */
const GENERIC_BODY_LINES = 40;

/** CSS custom property carrying a tool kind's consistent hue (see themes.css). */
export const toolColorVar = (kind: ToolKind): string => `var(--tool-${kind})`;

/**
 * Filename extension to a highlight.js language id. Undefined means "render as
 * plain text" — auto-detection stays off by design: it is slow, and it is wrong
 * on logs and command output.
 *
 * Adding an entry here is deliberate: the language must also be registered in
 * `highlight.ts`, or the extension simply renders as plain text.
 */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  lua: 'lua',
  nix: 'nix',
  dockerfile: 'dockerfile',
  swift: 'swift',
  scala: 'scala',
  pl: 'perl',
  r: 'r',
  diff: 'diff',
  patch: 'diff',
};

export const langFromPath = (path?: string): string | undefined => {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? path;
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const extension = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return EXTENSION_LANGUAGES[extension];
};

const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Images a tool result already carried to the browser. Parsing stays narrow —
 * base64 raster blocks only, never SVG — so transcript data cannot turn into an
 * active document inside the page.
 */
export const resultImages = (result: ToolResultData): readonly ToolResultImage[] => {
  if (!Array.isArray(result.content)) return [];
  const images: ToolResultImage[] = [];
  for (const part of result.content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: unknown; source?: unknown };
    if (block.type !== 'image' || !block.source || typeof block.source !== 'object') continue;
    const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown };
    if (source.type !== 'base64' || typeof source.media_type !== 'string' || typeof source.data !== 'string') continue;
    if (!INLINE_IMAGE_MEDIA_TYPES.has(source.media_type) || !source.data) continue;
    images.push({ mediaType: source.media_type as ToolResultImage['mediaType'], data: source.data });
  }
  return images;
};

/** Best-effort readable text of a tool result. */
export const resultText = (result: ToolResultData): string | null => {
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result.content)) {
    const parts = (result.content as ReadonlyArray<{ text?: string; type?: string }>)
      .map(part =>
        typeof part?.text === 'string' ? part.text : part?.type === 'image' ? null : `[${part?.type ?? 'unknown'}]`,
      )
      .filter((part): part is string => part !== null);
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : null;
  }
  if (result.content !== undefined && result.content !== null) return stringifySafe(result.content);
  return null;
};
