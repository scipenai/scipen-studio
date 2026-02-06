/**
 * @file ViewRegistry.ts - View Registry
 * @description Supports dynamic registration of sidebar views, implements extensible UI architecture
 * @depends shared/utils (Emitter, Event)
 */

import type React from 'react';
import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';

// ====== Type Definitions ======

/**
 * View location enum
 * Inspired by VS Code's ViewContainerLocation
 */
export enum ViewLocation {
  /** Left sidebar (Activity Bar) */
  Sidebar = 'sidebar',
  /** Right panel */
  RightPanel = 'rightPanel',
  /** Bottom panel */
  BottomPanel = 'bottomPanel',
}

/**
 * View descriptor
 * Inspired by VS Code's IViewDescriptor
 */
export interface ViewDescriptor {
  /** Unique identifier */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Icon component */
  readonly icon: React.ComponentType<{ size?: number }>;
  /** Sort order (smaller numbers appear first) */
  readonly order: number;
  /** View content component */
  readonly component: React.ComponentType;
  /** Conditional display function (hide when returns false) */
  readonly when?: () => boolean;
  /** View location, defaults to Sidebar */
  readonly location?: ViewLocation;
  /** Whether hidden by default */
  readonly hideByDefault?: boolean;
  /** Group (for visual separation) */
  readonly group?: 'primary' | 'secondary';
}

/**
 * View registration event
 */
export interface ViewRegistrationEvent {
  readonly view: ViewDescriptor;
  readonly location: ViewLocation;
}

/**
 * View deregistration event
 */
export interface ViewDeregistrationEvent {
  readonly viewId: string;
  readonly location: ViewLocation;
}

// ====== ViewRegistry Implementation ======

/**
 * View registry
 *
 * Manages registration, deregistration, and querying of all views
 */
export class ViewRegistry implements IDisposable {
  private readonly _disposables = new DisposableStore();

  /** Views stored by location Map */
  private readonly _viewsByLocation = new Map<ViewLocation, Map<string, ViewDescriptor>>();

  /** Fast lookup Map for all views */
  private readonly _viewsById = new Map<string, ViewDescriptor>();

  /** Cache: avoid infinite loops from getViews returning new arrays each time */
  private readonly _viewsCache = new Map<ViewLocation, ViewDescriptor[]>();

  // ====== Event Definitions ======

  private readonly _onDidRegisterView = new Emitter<ViewRegistrationEvent>();
  readonly onDidRegisterView: Event<ViewRegistrationEvent> = this._onDidRegisterView.event;

  private readonly _onDidDeregisterView = new Emitter<ViewDeregistrationEvent>();
  readonly onDidDeregisterView: Event<ViewDeregistrationEvent> = this._onDidDeregisterView.event;

  private readonly _onDidChangeViews = new Emitter<ViewLocation>();
  readonly onDidChangeViews: Event<ViewLocation> = this._onDidChangeViews.event;

  constructor() {
    this._viewsByLocation.set(ViewLocation.Sidebar, new Map());
    this._viewsByLocation.set(ViewLocation.RightPanel, new Map());
    this._viewsByLocation.set(ViewLocation.BottomPanel, new Map());

    this._disposables.add(this._onDidRegisterView);
    this._disposables.add(this._onDidDeregisterView);
    this._disposables.add(this._onDidChangeViews);
  }

  // ====== Registration Methods ======

  /**
   * Register a single view
   */
  registerView(descriptor: ViewDescriptor): IDisposable {
    const location = descriptor.location ?? ViewLocation.Sidebar;

    if (this._viewsById.has(descriptor.id)) {
      console.warn(`[ViewRegistry] View "${descriptor.id}" is already registered, overwriting.`);
      this.deregisterView(descriptor.id);
    }

    const locationViews = this._viewsByLocation.get(location)!;
    locationViews.set(descriptor.id, descriptor);
    this._viewsById.set(descriptor.id, descriptor);

    this._updateCache(location);

    this._onDidRegisterView.fire({ view: descriptor, location });
    this._onDidChangeViews.fire(location);

    return {
      dispose: () => {
        this.deregisterView(descriptor.id);
      },
    };
  }

  /**
   * Register multiple views
   */
  registerViews(descriptors: ViewDescriptor[]): IDisposable {
    const disposables = descriptors.map((d) => this.registerView(d));

    return {
      dispose: () => {
        disposables.forEach((d) => d.dispose());
      },
    };
  }

  /**
   * Deregister view
   */
  deregisterView(viewId: string): boolean {
    const descriptor = this._viewsById.get(viewId);
    if (!descriptor) {
      return false;
    }

    const location = descriptor.location ?? ViewLocation.Sidebar;
    const locationViews = this._viewsByLocation.get(location);

    if (locationViews) {
      locationViews.delete(viewId);
    }
    this._viewsById.delete(viewId);

    this._updateCache(location);

    this._onDidDeregisterView.fire({ viewId, location });
    this._onDidChangeViews.fire(location);

    return true;
  }

  // ====== Query Methods ======

  /**
   * Get all views at specified location (sorted and filtered)
   * Returns cached array reference to avoid React infinite loops from returning new arrays each time
   */
  getViews(location: ViewLocation): ViewDescriptor[] {
    if (!this._viewsCache.has(location)) {
      this._updateCache(location);
    }
    return this._viewsCache.get(location) ?? [];
  }

  /**
   * Get all views at specified location (including hidden ones, for settings panel)
   */
  getAllViews(location: ViewLocation): ViewDescriptor[] {
    const locationViews = this._viewsByLocation.get(location);
    if (!locationViews) {
      return [];
    }

    return Array.from(locationViews.values()).sort((a, b) => a.order - b.order);
  }

  /**
   * Get view by ID
   */
  getView(viewId: string): ViewDescriptor | undefined {
    return this._viewsById.get(viewId);
  }

  /**
   * Check if view is registered
   */
  hasView(viewId: string): boolean {
    return this._viewsById.has(viewId);
  }

  /**
   * Get view count
   */
  getViewCount(location?: ViewLocation): number {
    if (location) {
      return this._viewsByLocation.get(location)?.size ?? 0;
    }
    return this._viewsById.size;
  }

  // ====== Private Methods ======

  /**
   * Update view cache for specified location
   */
  private _updateCache(location: ViewLocation): void {
    const locationViews = this._viewsByLocation.get(location);
    if (!locationViews) {
      this._viewsCache.set(location, []);
      return;
    }

    const views = Array.from(locationViews.values())
      .filter((v) => !v.when || v.when())
      .filter((v) => !v.hideByDefault)
      .sort((a, b) => a.order - b.order);

    this._viewsCache.set(location, views);
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._viewsByLocation.clear();
    this._viewsById.clear();
    this._viewsCache.clear();
    this._disposables.dispose();
  }
}

// ====== Lazy Service Access ======

let _viewRegistry: ViewRegistry | null = null;

export function getViewRegistry(): ViewRegistry {
  if (!_viewRegistry) {
    const { getServices } = require('./ServiceRegistry');
    _viewRegistry = getServices().view;
  }
  return _viewRegistry!;
}

export function _setViewRegistryInstance(instance: ViewRegistry): void {
  _viewRegistry = instance;
}
