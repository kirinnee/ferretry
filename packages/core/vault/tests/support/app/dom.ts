/** The shell's DOM harness (`@ferretry/app/testing`), with a document registered. A test imports this, not `react-dom/client`. */
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';

ensureDom();

export { interact, mount, must };
