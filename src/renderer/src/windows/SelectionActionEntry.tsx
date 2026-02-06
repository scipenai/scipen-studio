/**
 * @file SelectionActionEntry.tsx - Selection action window entry
 * @description Independent React application entry for the selection action window, used for selectionAction.html
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import SelectionActionWindow from './SelectionActionWindow';

// Wait for DOM to load
const STARTUP_DELAY_MS = 50;

setTimeout(() => {
  const rootElement = document.getElementById('selection-action-root');
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <SelectionActionWindow />
      </React.StrictMode>
    );
  } else {
    console.error('[SelectionAction] Root element not found');
  }
}, STARTUP_DELAY_MS);
