/**
 * @file useAgentSidecarState - React binding for the SNACA sidecar lifecycle
 * @description Mirrors the main-process sidecar state machine (stopped /
 *   starting / running / crashed / failed / stopping) into React via
 *   `useSyncExternalStore`. The cache lives on the `agentClient` singleton;
 *   the first consumer triggers the initial fetch, later states arrive by
 *   push (`Agent_SidecarStateChanged`).
 *
 *   Consumers: the chat panel failure banner + composer gating, and the
 *   StatusBar agent indicator.
 */

import { useSyncExternalStore } from 'react';
import { agentClient, type AgentSidecarState } from '../services/agent/AgentClientService';

export function useAgentSidecarState(): AgentSidecarState | null {
  return useSyncExternalStore(
    (cb) => agentClient.subscribeSidecarState(cb),
    () => agentClient.getSidecarStateSync()
  );
}
