import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { init } from './lib/store';
import { startSync } from './lib/sync';
import { onFolderMessage, startFolder } from './lib/folder';
import { toast } from './ui/common';
import { startPwa } from './lib/pwa';
import { startWarmOffline } from './lib/strokes';
import './styles.css';

startPwa();

init()
  .then(async () => {
    onFolderMessage(toast);
    await startFolder();
    await startSync();
    startWarmOffline();
  })
  .catch((e) => {
    document.getElementById('root')!.textContent = `This browser could not open the app's storage: ${(e as Error).message}`;
  });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
