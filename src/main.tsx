import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { init } from './lib/store';
import './styles.css';

init().catch((e) => {
  document.getElementById('root')!.textContent = `This browser could not open the app's storage: ${(e as Error).message}`;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
