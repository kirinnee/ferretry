/**
 * The browser entry for the Settings choice samples: the REAL Editor style and Button layout rows (fake data, no daemon, no
 * network), drawn INSIDE the Settings shell's own frame so the shell's label rules and the real content width apply.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownComposerSettings } from '../../../../app/composer/markdown-composer-settings.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

function Scene() {
  const [vim, setVim] = useState(false);
  return (
    <section className="kt-panel p-panel" data-scene="composer">
      <h3 className="m-0 text-row font-semibold text-fg">Composer</h3>
      <div className="mt-3">
        <MarkdownComposerSettings vimEnabled={vim} onChangeVim={setVim} />
      </div>
    </section>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <section className="fy-page fy-settings" data-settings-open="panel">
      <div className="fy-settings-body">
        <div aria-hidden="true" className="fy-settings-nav" />
        <section className="fy-settings-page" aria-label="Composer">
          <Scene />
        </section>
      </div>
    </section>,
  );
