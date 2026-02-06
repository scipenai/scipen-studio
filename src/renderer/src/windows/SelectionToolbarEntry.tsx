/**
 * @file SelectionToolbarEntry.tsx - Selection toolbar entry
 * @description React application entry for the selection floating toolbar, used for selectionToolbar.html
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar';

const STARTUP_DELAY_MS = 50;

setTimeout(() => {
  const rootElement = document.getElementById('selection-toolbar-root');
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <SelectionToolbar />
      </React.StrictMode>
    );
  } else {
    console.error('[SelectionToolbar] 找不到 root 元素');
  }
}, STARTUP_DELAY_MS);
