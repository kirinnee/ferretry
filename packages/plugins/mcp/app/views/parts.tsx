/** The small pieces MCP's views are drawn with: a section, a note and a hint. One set, so the panel and the tab read as one surface. */
import { cn } from '@ferretry/app/ui';
import type { ReactNode } from 'react';

export function Section({ title, children, spot }: { title: string; children: ReactNode; spot?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-mcp-section={spot ?? title}>
      <h4 className="kt-label m-0">{title}</h4>
      {children}
    </section>
  );
}

const NOTE_TONE = {
  info: 'border-accent-border bg-accent-soft',
  warn: 'border-warn-border bg-warn-bg',
  danger: 'border-err-border bg-err-bg',
} as const;

export function Note({
  tone,
  title,
  children,
  actions,
  spot,
  role,
}: {
  tone: keyof typeof NOTE_TONE;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  spot?: string;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1 rounded-control border p-panel', NOTE_TONE[tone])}
      data-mcp-note={spot ?? tone}
      role={role}
    >
      <p className="m-0 break-words text-row font-semibold text-fg">{title}</p>
      {children === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1 break-words text-cell leading-base text-fg">{children}</div>
      )}
      {actions === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="m-0 text-cell leading-base text-muted">{children}</p>;
}
