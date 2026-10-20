/**
 * The box every page renders into, so the shell can remember where each page was scrolled
 * (`useRouteScrollMemory`). `display: contents`: it adds a node to listen on, never a box to lay out,
 * so a page's `h-full` still resolves against the frame around it.
 */

import { type ReactNode, useRef } from 'react';
import { useRouteScrollMemory } from '../hooks/use-route-scroll-memory.ts';
import type { ScrollMemory } from '../lib/scroll-memory.ts';

export interface PageScrollRegionProps {
  /** The history entry on screen (`useRouter().entryKey`). */
  readonly entryKey: string;
  readonly memory: ScrollMemory;
  readonly children: ReactNode;
}

export function PageScrollRegion({ entryKey, memory, children }: PageScrollRegionProps) {
  const region = useRef<HTMLDivElement>(null);
  useRouteScrollMemory(region, entryKey, memory);
  return (
    <div className="contents" data-page-scroll-region="" ref={region}>
      {children}
    </div>
  );
}
