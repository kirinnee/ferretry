/** Real screens, real chat-line navigation and shared receipts; only the daemon and shell are synthetic. */
import { createRoot } from 'react-dom/client';
import { pendingAnswerRoutes } from '../../../support/app/pending-answer-routes.tsx';

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';
const scene = pendingAnswerRoutes();
declare global {
  interface Window {
    scene: {
      readonly go: (to: string) => void;
      readonly state: typeof scene.state;
      readonly commitCount: () => number;
      readonly accept: () => void;
      readonly refuse: (reason: string) => void;
      readonly refuseAt: (index: number, reason: string) => void;
    };
  }
}
window.scene = {
  go: scene.go,
  state: scene.state,
  commitCount: () => scene.commits.length,
  accept: () => scene.commits.shift()?.resolve(),
  refuse: reason => scene.commits.shift()?.reject(new Error(reason)),
  refuseAt: (index, reason) => scene.commits[index]?.reject(new Error(reason)),
};
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<scene.Scene />);
