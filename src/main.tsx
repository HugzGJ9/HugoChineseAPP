import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { getState, init } from './lib/store';
import { linkOneDrive, onRebase, startSync, syncTarget } from './lib/sync';
import { checkFolder, onFolderMessage, startFolder } from './lib/folder';
import { checkWorkbook, onWorkbookMessage, startWorkbook } from './lib/workbook';
import { completeSignIn, msSignIn, shouldRenewAtStart, takeAuthResponse } from './lib/ms/auth';
import { toast } from './ui/common';
import { startPwa } from './lib/pwa';
import { startWarmOffline } from './lib/strokes';
import './styles.css';

startPwa();

// Back from Microsoft sign-in: the answer leaves the address bar and the route comes back before the first render.
const auth = takeAuthResponse();

init()
  .then(async () => {
    onFolderMessage(toast);
    onWorkbookMessage(toast);
    // Sync took an older shared list while the workbook here was newer: read the workbook again on top of it (plan D3).
    onRebase(() => (getState().ms.state === 'ok' ? checkWorkbook(true) : checkFolder(true)));
    let signedIn = false;
    if (auth) {
      try {
        await completeSignIn(auth);
        signedIn = getState().ms.state === 'ok';
      } catch (e) {
        toast(`Microsoft sign-in did not finish: ${(e as Error).message}`);
      }
    }
    // Signing in with Microsoft is the whole setup: a device that syncs nowhere yet syncs through OneDrive (plan Q3).
    // Before the readers start, so the workbook is read on top of the shared list.
    if (signedIn && !(await syncTarget())) {
      await linkOneDrive().catch((e: unknown) => toast(`Sync through OneDrive could not start: ${(e as Error).message}`));
    }
    // Microsoft sign-ins of web apps last 24 hours: renew before they lapse (a short redirect, back in a moment).
    if (await shouldRenewAtStart(Date.now()).catch(() => false)) {
      try {
        return void (await msSignIn({ silent: true }));
      } catch {
        // Not renewed: the app runs on, the Reconnect banner shows once the sign-in lapses.
      }
    }
    await startFolder();
    await startWorkbook();
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
