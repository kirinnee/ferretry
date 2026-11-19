/**
 * The browser entry for "a row can be dragged in a real engine": the REAL `SortableList` over four fake nav items, in a
 * narrow column with room beside it to release the pointer OUTSIDE the list. Every reorder it is told about lands in
 * `window.__reorders` (one array of keys per call), so the test reads what the caller would have been given.
 *
 *   ?theme=<family>-<mode>
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SortableList } from '../../../src/ui/sortable-list.tsx';

declare global {
  interface Window {
    __reorders: string[][];
  }
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
window.__reorders = [];

const NAMES = ['Ferrets', 'Agenda', 'Board', 'Insights'] as const;

function Scene() {
  const [items, setItems] = useState<readonly string[]>(NAMES);
  return (
    <main className="bg-bg text-fg" style={{ minHeight: '100vh', padding: 16 }}>
      <div style={{ width: 320 }}>
        <SortableList
          itemKey={name => name}
          itemLabel={name => name}
          items={items}
          label="Navigation items"
          onReorder={next => {
            window.__reorders.push([...next]);
            setItems(next);
          }}
          renderItem={name => <span>{name}</span>}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
