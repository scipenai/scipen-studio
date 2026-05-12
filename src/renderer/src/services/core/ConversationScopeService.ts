import { Emitter, type Event, type IDisposable } from '../../../../../shared/utils';
import type {
  ProjectConversationBindingDTO,
  ProjectConversationBindingChangedEvent,
  ProjectConversationScopeType,
} from '../../../../../shared/api-types';
import { api } from '../../api';
import type { AppSettings } from '../../types';
import {
  freezeCollaborationSnapshot,
  invalidateFrozenSnapshot,
} from '../../utils/im-collaboration';

interface SettingsLike {
  readonly settings: AppSettings;
}

export interface ProjectConversationScope {
  scopeType: ProjectConversationScopeType;
  projectId: string | null;
  localRootPath: string | null;
  workspaceId: string | null;
  title: string | null;
}

function normalizeLocalRootPath(localRootPath?: string | null): string | null {
  if (!localRootPath) return null;
  return localRootPath.replace(/\\/g, '/');
}

/**
 * Resolve-or-timeout helper for IPC awaits that hit the IM REST API.
 * Without this, a slow/unreachable IM server would let `resolveCurrentScope`
 * hang for the full 30s+ retry budget, which delays the first paint while the
 * user is staring at a black window on a flaky network.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const SCOPE_RESOLVE_TIMEOUT_MS = 5000;

export class ConversationScopeService implements IDisposable {
  /** IPC event listener cleanup function */
  private _bindingChangedCleanup: (() => void) | null = null;
  /** Single-flight guard: tracks whether a push-triggered refresh is running */
  private _pushRefreshInProgress = false;
  /** Set when a new event arrives during hydrate/pushRefresh */
  private _needsRefreshAfterHydrate = false;

  constructor(private readonly settingsService: SettingsLike) {
    this._bindingChangedCleanup = api.projectConversation.onBindingChanged((event) => {
      this.handleBindingChanged(event);
    });
  }

  private _activeBinding: ProjectConversationBindingDTO | null = null;
  private _bindings: ProjectConversationBindingDTO[] = [];
  private _lastError: string | null = null;
  private _scope: ProjectConversationScope = {
    scopeType: 'global',
    projectId: null,
    localRootPath: null,
    workspaceId: null,
    title: null,
  };
  private _isHydrating = false;
  /** Monotonic counter; incremented on each resolveCurrentScope, checked post-await for staleness */
  private _resolveEpoch = 0;

  private readonly _onDidChangeActiveBinding = new Emitter<ProjectConversationBindingDTO | null>();
  readonly onDidChangeActiveBinding: Event<ProjectConversationBindingDTO | null> =
    this._onDidChangeActiveBinding.event;

  private readonly _onDidChangeBindings = new Emitter<ProjectConversationBindingDTO[]>();
  readonly onDidChangeBindings: Event<ProjectConversationBindingDTO[]> =
    this._onDidChangeBindings.event;

  private readonly _onDidChangeScope = new Emitter<ProjectConversationScope>();
  readonly onDidChangeScope: Event<ProjectConversationScope> = this._onDidChangeScope.event;

  private readonly _onDidChangeHydrating = new Emitter<boolean>();
  readonly onDidChangeHydrating: Event<boolean> = this._onDidChangeHydrating.event;

  private readonly _onDidChangeLastError = new Emitter<string | null>();
  readonly onDidChangeLastError: Event<string | null> = this._onDidChangeLastError.event;

  get activeBinding(): ProjectConversationBindingDTO | null {
    return this._activeBinding;
  }

  get bindings(): ProjectConversationBindingDTO[] {
    return this._bindings;
  }

  /** Clear the active binding immediately (used on project switch so IM does not linger on the old session). */
  clearActiveBinding(): void {
    if (this._activeBinding) {
      this._activeBinding = null;
      this._onDidChangeActiveBinding.fire(null);
    }
  }

  get activeConversationId(): string | null {
    return this._activeBinding?.conversationId ?? null;
  }

  get scope(): ProjectConversationScope {
    return this._scope;
  }

  get isHydrating(): boolean {
    return this._isHydrating;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  async activateGlobalScope(params?: {
    workspaceId?: string | null;
    title?: string | null;
  }): Promise<void> {
    invalidateFrozenSnapshot();
    this._scope = {
      scopeType: 'global',
      projectId: null,
      localRootPath: null,
      workspaceId: params?.workspaceId ?? null,
      title: params?.title ?? 'SciPen Global',
    };
    // Clear the old binding immediately so the UI does not remain on the previous session during resolve
    this._activeBinding = null;
    this._onDidChangeActiveBinding.fire(null);
    this._onDidChangeScope.fire(this._scope);
    await this.resolveCurrentScope({
      title: params?.title ?? 'SciPen Global',
    });
  }

  async activateProjectScope(params: {
    projectId?: string | null;
    localRootPath?: string | null;
    workspaceId?: string | null;
    title?: string | null;
    createIfMissing?: boolean;
  }): Promise<void> {
    invalidateFrozenSnapshot();
    this._scope = {
      scopeType: 'project',
      projectId: params.projectId ?? null,
      localRootPath: normalizeLocalRootPath(params.localRootPath),
      workspaceId: params.workspaceId ?? null,
      title: params.title ?? null,
    };
    // Clear the old binding immediately so the UI does not remain on the previous session during resolve
    this._activeBinding = null;
    this._onDidChangeActiveBinding.fire(null);
    this._onDidChangeScope.fire(this._scope);
    await this.resolveCurrentScope({
      title: params.title ?? null,
      createIfMissing: params.createIfMissing ?? true,
    });
  }

  async refreshCurrentScope(): Promise<void> {
    await this.resolveCurrentScope({
      title: this._scope.title,
      createIfMissing: false,
    });
  }

  dispose(): void {
    if (this._bindingChangedCleanup) {
      this._bindingChangedCleanup();
      this._bindingChangedCleanup = null;
    }
    this._onDidChangeActiveBinding.dispose();
    this._onDidChangeBindings.dispose();
    this._onDidChangeScope.dispose();
    this._onDidChangeHydrating.dispose();
    this._onDidChangeLastError.dispose();
  }

  /**
   * Handle Main→Renderer push: read-only refresh once the event matches the current scope.
   * `set_default` always refreshes; other reasons require scope match.
   */
  private handleBindingChanged(event: ProjectConversationBindingChangedEvent): void {
    if (event.runtime !== 'openclaw') return;

    const scopeMatches =
      event.scopeType === this._scope.scopeType &&
      (event.scopeType === 'global' ||
        (event.projectId === this._scope.projectId &&
          normalizeLocalRootPath(event.localRootPath) ===
            normalizeLocalRootPath(this._scope.localRootPath)));

    if (!scopeMatches && event.reason !== 'set_default' && event.reason !== 'deleted') return;

    // Single-flight guard
    if (this._isHydrating || this._pushRefreshInProgress) {
      this._needsRefreshAfterHydrate = true;
      return;
    }

    this._pushRefreshInProgress = true;
    this.resolveCurrentScope({ createIfMissing: event.reason === 'deleted' }).finally(() => {
      this._pushRefreshInProgress = false;
      if (this._needsRefreshAfterHydrate) {
        this._needsRefreshAfterHydrate = false;
        this.handleBindingChanged(event);
      }
    });
  }

  private async resolveCurrentScope(options: {
    title?: string | null;
    createIfMissing?: boolean;
  }): Promise<void> {
    // Epoch mechanism: bump counter and check staleness after await (superseded by a newer call)
    const epoch = ++this._resolveEpoch;
    const isStale = () => epoch !== this._resolveEpoch;

    const settings = this.settingsService.settings;

    if (!settings.im.serverUrl || !settings.im.token) {
      if (isStale()) return;
      this._bindings = [];
      this._activeBinding = null;
      this._lastError = null;
      this._onDidChangeBindings.fire(this._bindings);
      this._onDidChangeActiveBinding.fire(this._activeBinding);
      this._onDidChangeLastError.fire(this._lastError);
      return;
    }

    // project scope requires at least one of projectId or localRootPath
    if (
      this._scope.scopeType === 'project' &&
      !this._scope.projectId &&
      !this._scope.localRootPath
    ) {
      if (isStale()) return;
      this._bindings = [];
      this._activeBinding = null;
      this._lastError = null;
      this._onDidChangeBindings.fire(this._bindings);
      this._onDidChangeActiveBinding.fire(this._activeBinding);
      this._onDidChangeLastError.fire(this._lastError);
      return;
    }

    this._isHydrating = true;
    this._onDidChangeHydrating.fire(true);

    // Snapshot the current scope — this._scope may change during the upcoming awaits
    const scopeSnapshot = { ...this._scope };

    try {
      const binding = await withTimeout(
        api.projectConversation.resolve({
          runtime: 'openclaw',
          scopeType: scopeSnapshot.scopeType,
          projectId: scopeSnapshot.projectId,
          localRootPath: scopeSnapshot.localRootPath,
          workspaceId: scopeSnapshot.workspaceId,
          title: options.title ?? scopeSnapshot.title,
          createIfMissing: options.createIfMissing ?? true,
          imConfig: {
            baseUrl: settings.im.serverUrl,
            token: settings.im.token,
          },
        }),
        SCOPE_RESOLVE_TIMEOUT_MS,
        'projectConversation.resolve'
      );

      // Post-await staleness check: drop the result if a newer resolve superseded this one
      if (isStale()) return;

      let bindings: ProjectConversationBindingDTO[] = [];
      try {
        bindings = await withTimeout(
          api.projectConversation.list({
            runtime: 'openclaw',
            scopeType: scopeSnapshot.scopeType,
            projectId: scopeSnapshot.projectId,
            localRootPath: scopeSnapshot.localRootPath,
          }),
          SCOPE_RESOLVE_TIMEOUT_MS,
          'projectConversation.list'
        );
      } catch (listError) {
        console.warn(
          '[ConversationScopeService] Failed to list bindings, falling back to active binding only:',
          listError
        );
        bindings = binding ? [binding] : [];
      }

      if (isStale()) return;

      this._bindings =
        binding && !bindings.some((item) => item.id === binding.id)
          ? [binding, ...bindings]
          : bindings;
      this._activeBinding = binding;
      this._lastError = null;

      // Freeze the collaboration snapshot after scope resolution to shrink the send-message race window
      if (binding?.conversationId) {
        freezeCollaborationSnapshot(binding.conversationId);
      }
    } catch (error) {
      if (isStale()) return;

      console.error('[ConversationScopeService] Failed to resolve conversation scope:', error);
      const message = error instanceof Error ? error.message : String(error);

      this._bindings = [];
      this._activeBinding = null;
      this._lastError = message;
    } finally {
      // Only the latest epoch notifies downstream — stale requests exit silently
      if (!isStale()) {
        this._onDidChangeBindings.fire(this._bindings);
        this._onDidChangeActiveBinding.fire(this._activeBinding);
        this._isHydrating = false;
        this._onDidChangeHydrating.fire(false);
        this._onDidChangeLastError.fire(this._lastError);
      }
    }
  }
}
