/**
 * @file useZoteroBibMirror — two subscription channels for the Zotero mirror.
 *
 * @description
 *   - `useZoteroMirrorLifecycle()`: App-level lifecycle hook. **Does not subscribe
 *     to mirror state.** Only gates start/stop of the singleton mirror on
 *     `integrationEnabled`. Mounted at the top of App.tsx so the mirror stays
 *     alive even when StatusBadge unmounts.
 *   - `useZoteroBibMirror()`: state subscription hook backed by
 *     `useSyncExternalStore` listening to `mirror.bumpSnapshot`. Used at the
 *     component level (StatusBadge / Diagnostics / @cite popover) — only the
 *     consuming component re-renders on mirror state churn.
 *
 *   Architectural motivation: previously App.tsx called `useZoteroBibMirror()`
 *   at the root, binding the state subscription to the root node. Every mirror
 *   status flicker (every 1-3s) invalidated the whole tree, causing tab
 *   switching and editor interactions to stutter. Splitting the hooks confines
 *   App re-renders to `enabled` changes (rare) while state churn only reaches
 *   the leaves that actually consume it.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import {
  getZoteroBibMirror,
  type ZoteroBibMirror,
  type ZoteroBibMirrorState,
} from '../services/zotero/ZoteroBibMirror';

const logger = createLogger('useZoteroBibMirror');

export interface UseZoteroBibMirrorResult {
  state: ZoteroBibMirrorState;
  mirror: ZoteroBibMirror;
  enabled: boolean;
}

/**
 * Shared sub-hook — fetches and subscribes to the `integrationEnabled` setting.
 * Both public hooks use it, each keeping its own local state (parallel
 * subscriptions on the same IPC channel). Intentionally not extracted into
 * context: `enabled` changes are rare (only on user toggle), so two parallel
 * subscriptions cost effectively nothing.
 */
function useZoteroIntegrationEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void api.zotero
      .getSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(Boolean(settings.integrationEnabled));
      })
      .catch((err) => logger.warn('getSettings failed', err));

    const unsub = api.zotero.onSettingsChanged((settings) => {
      setEnabled(Boolean(settings.integrationEnabled));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return enabled;
}

/**
 * App-level mirror lifecycle — mounted at the top of App.tsx. **Does not
 * subscribe to state**, so App does not re-render on mirror.bumpSnapshot.
 * Only enabled toggle triggers an App re-render (acceptable).
 */
export function useZoteroMirrorLifecycle(): void {
  const mirror = getZoteroBibMirror();
  const enabled = useZoteroIntegrationEnabled();

  useEffect(() => {
    if (enabled) {
      void mirror.start();
    } else {
      mirror.stop();
    }
    return () => {
      mirror.stop();
    };
  }, [enabled, mirror]);
}

/**
 * Component-level state subscription — used by StatusBadge / DiagnosticsPopover /
 * @cite candidate popover. useSyncExternalStore keeps React in sync with
 * mirror.bumpSnapshot; only the calling component re-renders, no upstream
 * pollution.
 */
export function useZoteroBibMirror(): UseZoteroBibMirrorResult {
  const mirror = getZoteroBibMirror();
  const enabled = useZoteroIntegrationEnabled();

  const state = useSyncExternalStore(
    (listener) => mirror.subscribe(listener),
    () => mirror.getState(),
    () => mirror.getState()
  );

  return { state, mirror, enabled };
}
