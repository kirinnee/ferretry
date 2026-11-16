/** The catalog review's warnings and review body, drawn by the real views in a real browser; `?theme=` picks the theme. */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewBody, WarningList } from '../../../../app/features/catalogs/catalog-review-view.tsx';
import { reviewPreview } from './catalog-review-cases.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/** Says the first commit is on screen, so the driver measures the drawn page and not an empty root. */
function Review() {
  useEffect(() => {
    document.documentElement.dataset.sceneReady = '1';
  }, []);
  return (
    <div className="flex flex-col gap-sm p-panel">
      <WarningList warnings={reviewPreview.warnings} />
      <ReviewBody entries={reviewPreview.review} />
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('❌ the catalog review scene has no #root');
createRoot(root).render(<Review />);
