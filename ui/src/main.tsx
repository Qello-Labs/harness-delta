import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UiRouter } from './UiRouter';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiRouter />
  </StrictMode>
);
