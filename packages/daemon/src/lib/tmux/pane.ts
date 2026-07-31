import type { PaneMetadata } from './contracts.ts';

const STARTUP_BLOCKERS = ['do you trust the contents of this directory', 'press enter to continue', 'invalid api key'];
const ACTIVE_WORK = ['esc to interrupt', 'ctrl+c to interrupt'];
const PROMPT = /^\s*[│|]?\s*[>›❯»](?:[\s\u00a0].*)?$/u;

export function parsePaneMetadata(value: string): PaneMetadata {
  const [dead, exitCode, cursorX, cursorY, height, width] = value.trimEnd().split('|');
  const number = (field: string | undefined): number | undefined => {
    const parsed = Number(field);
    return field === undefined || field === '' || !Number.isFinite(parsed) ? undefined : parsed;
  };
  return {
    dead: dead === '1',
    exitCode: number(exitCode),
    cursorX: number(cursorX),
    cursorY: number(cursorY),
    height: number(height),
    width: number(width),
  };
}

export function paneShowsActiveWork(pane: string): boolean {
  const lower = pane.toLowerCase();
  return ACTIVE_WORK.some(marker => lower.includes(marker)) || /\bworking\s*\(\s*\d+[ms]/.test(lower);
}

export function promptIsReady(pane: string, cursorY?: number, cursorX?: number): boolean {
  const lower = pane.toLowerCase();
  if (STARTUP_BLOCKERS.some(marker => lower.includes(marker)) || paneShowsActiveWork(pane)) return false;
  if (lower.includes('tell the model what to do differently')) return true;
  const lines = pane.split('\n');
  if (cursorY !== undefined && cursorY >= 0 && cursorY < lines.length) {
    const line = lines[cursorY]!;
    return (cursorX === undefined || cursorX <= 2) && PROMPT.test(line) && !/^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u.test(line);
  }
  return lines.slice(-30).some(line => PROMPT.test(line));
}
