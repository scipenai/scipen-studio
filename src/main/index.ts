/**
 * @file Main Process Entry - Electron Main Process
 * @description Application startup, window management, service initialization and IPC registration
 * @depends ServiceRegistry, IPC Handlers, Security, CompilerRegistry, LSPRegistry
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  app,
  crashReporter,
  dialog,
  globalShortcut,
  shell,
} from 'electron';
import log from 'electron-log';
import fs from './services/knowledge/utils/fsCompat';

import {
  getAIService,
  getAgentService,
  getChatOrchestrator,
  getFileSystemService,
  getSelectionServiceFromContainer,
  getSyncTeXServiceFromContainer,
  registerServices,
  shutdownServices,
  warmupServices,
} from './services/ServiceRegistry';
// ====== Service Registry (DI Pattern) ======
import { getKnowledgeService } from './services/knowledge';

import { createLocalReplicaService } from './services/LocalReplicaService';
import { createOverleafFileSystemService } from './services/OverleafFileSystemService';
import type {
  ILocalReplicaService,
  IOverleafFileSystemService,
  IOverleafService,
} from './services/interfaces';

import { initAllowedDirs, setupCSP } from './security';
import {
  clearAllowedDirectories,
  registerLocalFileProtocol,
  registerProtocolSchemes,
} from './services/LocalFileProtocol';

// ====== Registry Initialization (Lazy-Load) ======
import { initializeCompilerRegistry } from './services/compiler/setup';
import { initializeLSPRegistry } from './services/lsp/setup';

// ====== IPC Handlers ======
import {
  registerAIHandlers,
  registerAgentHandlers,
  registerChatHandlers,
  registerCompileHandlers,
  registerConfigHandlers,
  registerDialogHandlers,
  registerFileHandlers,
  registerKnowledgeHandlers,
  registerLSPHandlers,
  registerOverleafHandlers,
  registerSelectionHandlers,
  registerSettingsHandlers,
  registerWindowHandlers,
  setupKnowledgeEventForwarding,
} from './ipc';
import {
  registerLocalReplicaHandlers,
  setupLocalReplicaEventForwarding,
} from './ipc/localReplicaHandlers';

const Dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ electron-log Configuration ============
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 10 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

Object.assign(console, log.functions);

process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ====== Crash Reporter ======
crashReporter.start({
  companyName: 'SciPen',
  productName: 'SciPen Studio',
  submitURL: '',
  uploadToServer: false,
  compress: true,
});
log.info('[Main] Crash reporter started');

// ====== GPU Acceleration ======
// Why: Early GPU channel establishment improves startup time
app.commandLine.appendSwitch(
  'enable-features',
  'EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
);

// electron-vite outputs to: out/main, out/preload, out/renderer
process.env.APP_ROOT = path.join(Dirname, '..', '..');

// electron-vite uses ELECTRON_RENDERER_URL in dev mode
export const ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
export const isDev = !!ELECTRON_RENDERER_URL;
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'out', 'main');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'out', 'renderer');

log.info('[Main] __dirname:', Dirname);
log.info('[Main] APP_ROOT:', process.env.APP_ROOT);
log.info('[Main] isDev:', isDev);
log.info('[Main] ELECTRON_RENDERER_URL:', ELECTRON_RENDERER_URL);
log.info('[Main] MAIN_DIST:', MAIN_DIST);
log.info('[Main] RENDERER_DIST:', RENDERER_DIST);
log.info('[Main] Log file path:', log.transports.file.getFile()?.path);

process.env.VITE_PUBLIC = isDev ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

log.info('[Main] VITE_PUBLIC:', process.env.VITE_PUBLIC);

// ====== Single Instance Lock & File Association ======

const SUPPORTED_EXTENSIONS = ['.tex', '.bib', '.sty', '.cls', '.ltx'];
let pendingFilePath: string | null = null;

function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function getFilePathFromArgs(args: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (arg.includes('electron') || arg.includes('node_modules')) continue;
    if (isSupportedFile(arg) && fs.existsSync(arg)) {
      return arg;
    }
  }
  return null;
}

function openFileInWindow(filePath: string, targetWindow?: BrowserWindow | null): void {
  const win = targetWindow || mainWindow;
  if (!win) {
    pendingFilePath = filePath;
    log.info('[Main] Window not ready, pending file:', filePath);
    return;
  }

  log.info('[Main] Opening file:', filePath);
  win.webContents.send('open-file', filePath);

  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
}

// Must register protocol schemes before app ready
registerProtocolSchemes();

// ====== Single Instance Lock ======

// Allow multiple instances in test mode for parallel test execution
const isTestMode =
  process.env.SCIPEN_ALLOW_MULTIPLE_INSTANCES === 'true' ||
  process.env.SCIPEN_E2E_TEST === 'true' ||
  process.env.NODE_ENV === 'test';

const gotTheLock = isTestMode ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info('[Main] Another instance is running, quitting...');
  app.quit();
} else {
  if (!isTestMode) {
    app.on('second-instance', (_event, commandLine, _workingDirectory) => {
      const filePath = getFilePathFromArgs(commandLine);
      if (filePath) {
        openFileInWindow(filePath);
      } else if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });
  }
}

// ====== macOS: open-file Event ======

app.on('open-file', (event, filePath) => {
  event.preventDefault();

  if (!isSupportedFile(filePath)) {
    log.info('[Main] Unsupported file type:', filePath);
    return;
  }

  if (app.isReady() && mainWindow) {
    openFileInWindow(filePath);
  } else {
    pendingFilePath = filePath;
  }
});

// ====== Multi-Window Management ======

const windows: Map<number, BrowserWindow> = new Map();
let mainWindow: BrowserWindow | null = null;
let windowIdCounter = 0;

// ====== Stateful Services ======
// Why: Overleaf services maintain login state and cookies, so they must be created dynamically
// Other services are obtained from ServiceContainer via DI
let overleafCompiler: IOverleafService | null = null;
let overleafFileSystem: IOverleafFileSystemService | null = null;
let localReplicaService: ILocalReplicaService | null = null;

// ====== Recent Projects ======
const recentProjectsFile = path.join(app.getPath('userData'), 'recent-projects.json');

async function loadRecentProjects(): Promise<
  Array<{
    id: string;
    name: string;
    path: string;
    lastOpened: string;
    isRemote?: boolean;
  }>
> {
  try {
    if (await fs.pathExists(recentProjectsFile)) {
      const data = await fs.readJson<{
        projects?: Array<{
          id: string;
          name: string;
          path: string;
          lastOpened: string;
          isRemote?: boolean;
        }>;
      }>(recentProjectsFile);
      return data.projects || [];
    }
  } catch (error) {
    console.error('Failed to load recent projects:', error);
  }
  return [];
}

async function saveRecentProjects(
  projects: Array<{
    id: string;
    name: string;
    path: string;
    lastOpened: string;
    isRemote?: boolean;
  }>
): Promise<void> {
  try {
    await fs.writeJson(recentProjectsFile, { projects }, { spaces: 2 });
  } catch (error) {
    console.error('Failed to save recent projects:', error);
  }
}

async function addRecentProject(projectPath: string, isRemote?: boolean): Promise<void> {
  const projects = await loadRecentProjects();
  const projectName = path.basename(projectPath);
  const projectId = Buffer.from(projectPath).toString('base64');

  const filteredProjects = projects.filter((p) => p.path !== projectPath);

  filteredProjects.unshift({
    id: projectId,
    name: projectName,
    path: projectPath,
    lastOpened: new Date().toISOString(),
    isRemote,
  });

  await saveRecentProjects(filteredProjects.slice(0, 10));
}

/**
 * Creates a new application window.
 */
function createWindow(options?: { projectPath?: string }): number {
  const appPath = app.getAppPath();

  let preloadPath: string;
  if (app.isPackaged) {
    preloadPath = path.join(appPath, 'out', 'preload', 'index.mjs');
  } else {
    preloadPath = path.join(Dirname, '..', 'preload', 'index.mjs');
  }

  const windowId = ++windowIdCounter;

  // Build icon path - use resources directory (works in both dev and production)
  // process.resourcesPath is Electron-specific, not in Node.js types
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const iconPath = isDev
    ? path.join(process.env.APP_ROOT || '', 'resources', 'icon.png')
    : path.join(resourcesPath || '', 'icon.png');
  log.info('[Main] Icon path:', iconPath);
  log.info('[Main] Icon exists:', fs.pathExistsSync(iconPath));

  const isMac = process.platform === 'darwin';

  const newWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    // Why: macOS uses hidden inset title bar for native feel; Windows/Linux need standard title bar for menu
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 15, y: 10 },
        }
      : {}),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      // Why: sandbox=false required because electron-vite compiles preload as ESM
      sandbox: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  windows.set(windowId, newWindow);

  if (!mainWindow) {
    mainWindow = newWindow;
  }

  newWindow.on('closed', () => {
    windows.delete(windowId);
    if (mainWindow === newWindow) {
      mainWindow = windows.size > 0 ? (windows.values().next().value ?? null) : null;
    }

    // Why: SelectionService's hidden windows (ActionWindow/ToolbarWindow) prevent
    // Electron's window-all-closed event from firing, so we manually trigger quit
    if (windows.size === 0 && process.platform !== 'darwin') {
      log.info('[Main] All main windows closed, triggering app.quit()');
      app.quit();
    }
  });

  newWindow.webContents.on('did-finish-load', () => {
    if (options?.projectPath) {
      newWindow.webContents.send('open-project-path', options.projectPath);
    }
    newWindow.webContents.send('main-process-message', new Date().toLocaleString());
  });

  if (isDev && ELECTRON_RENDERER_URL) {
    newWindow.loadURL(ELECTRON_RENDERER_URL);
    newWindow.webContents.openDevTools();
  } else {
    newWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  log.info(`[Main] Created window ${windowId}, total windows: ${windows.size}`);
  return windowId;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    mainWindow = null;
  }
});

// ====== Graceful Shutdown ======
let isCleanupDone = false;

app.on('before-quit', async (e) => {
  if (isCleanupDone) {
    return;
  }

  // Prevent immediate exit, wait for async cleanup
  e.preventDefault();

  log.info('[Main] App quitting, shutting down services...');

  // Safety net: Force exit after 5s to prevent stuck cleanup blocking app exit
  const forceQuitTimer = setTimeout(() => {
    log.error('[Main] Shutdown timed out, forcing exit');
    app.exit(0);
  }, 5000);

  try {
    clearAllowedDirectories();

    // All services (including SelectionService) are managed by ServiceRegistry,
    // so shutdownServices() handles cleanup via container.dispose()
    await shutdownServices();

    log.info('[Main] All services shut down successfully');
  } catch (error) {
    log.error('[Main] Error during shutdown:', error);
  } finally {
    clearTimeout(forceQuitTimer);
    isCleanupDone = true;
    app.quit();
  }
});

app.on('will-quit', () => {
  log.info('[Main] will-quit: Final cleanup...');
  globalShortcut.unregisterAll();
  log.info('[Main] Global shortcuts unregistered');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(async () => {
  setupCSP();
  initAllowedDirs();

  // Why: Custom protocol for efficient loading of large files (PDFs)
  registerLocalFileProtocol();

  registerServices();

  // Lazy-load: Only registers metadata here; actual services instantiated on first use
  initializeCompilerRegistry();
  initializeLSPRegistry();

  // Why: createWindow() must precede registerIpcHandlers() because AI SDK imports zod,
  // which fails if loaded before Electron is fully initialized
  createWindow();
  registerIpcHandlers();
  setupApplicationMenu();

  // Why: Initialize knowledge service after window creation so startup isn't blocked by failures
  try {
    const knowledgeService = getKnowledgeService();
    await knowledgeService.initialize({});
    log.info('[Main] Knowledge service initialized successfully');
  } catch (error) {
    log.error('[Main] Failed to initialize knowledge service:', error);
  }

  // ====== Renderer Unresponsive Detection ======
  app.on('web-contents-created', (_event, webContents) => {
    let isHandlingUnresponsive = false;

    webContents.on('unresponsive', async () => {
      if (isHandlingUnresponsive) return;
      isHandlingUnresponsive = true;

      log.warn('[Main] Renderer process unresponsive');

      // Try to collect JS call stack for debugging (Electron 25+)
      try {
        const mainFrame = webContents.mainFrame;
        if (mainFrame && 'collectJavaScriptCallStack' in mainFrame) {
          const collectFn = (mainFrame as { collectJavaScriptCallStack?: () => Promise<string> })
            .collectJavaScriptCallStack;
          if (typeof collectFn === 'function') {
            const callStack = await collectFn.call(mainFrame);
            if (callStack) {
              log.error('[Main] Renderer unresponsive call stack:', callStack);
            }
          }
        }
      } catch {
        log.debug('[Main] collectJavaScriptCallStack not available or failed');
      }

      try {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: 'Page Unresponsive',
          message: 'The renderer process appears to be unresponsive.',
          buttons: ['Wait', 'Reload'],
          defaultId: 0,
          cancelId: 0,
        });

        if (response === 1) {
          webContents.reload();
        }
      } finally {
        isHandlingUnresponsive = false;
      }
    });

    webContents.on('responsive', () => {
      isHandlingUnresponsive = false;
      log.info('[Main] Renderer process became responsive again');
    });
  });

  // Async warmup - doesn't block startup
  warmupServices().catch((err) => {
    console.error('[Main] Service warmup failed:', err);
  });

  // Handle file association on Windows startup
  if (process.platform === 'win32') {
    const filePath = getFilePathFromArgs(process.argv);
    if (filePath && mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => {
        openFileInWindow(filePath);
      });
    }
  }

  // Handle open-file events received before app was ready (macOS)
  if (pendingFilePath && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (pendingFilePath) {
        openFileInWindow(pendingFilePath);
        pendingFilePath = null;
      }
    });
  }
});

// ====== Application Menu ======

function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        isMac
          ? { label: 'Close Window', role: 'close' as const, accelerator: 'CmdOrCtrl+W' }
          : { label: 'Exit', role: 'quit' as const, accelerator: 'Alt+F4' },
      ],
    },

    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' as const, accelerator: 'CmdOrCtrl+Z' },
        { label: 'Redo', role: 'redo' as const, accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y' },
        { type: 'separator' as const },
        { label: 'Cut', role: 'cut' as const, accelerator: 'CmdOrCtrl+X' },
        { label: 'Copy', role: 'copy' as const, accelerator: 'CmdOrCtrl+C' },
        { label: 'Paste', role: 'paste' as const, accelerator: 'CmdOrCtrl+V' },
        ...(isMac
          ? [
              { label: 'Paste and Match Style', role: 'pasteAndMatchStyle' as const },
              { label: 'Delete', role: 'delete' as const },
              { label: 'Select All', role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
            ]
          : [
              { label: 'Delete', role: 'delete' as const },
              { type: 'separator' as const },
              { label: 'Select All', role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
            ]),
      ],
    },

    {
      label: 'View',
      submenu: [
        { label: 'Reload', role: 'reload' as const, accelerator: 'CmdOrCtrl+R' },
        { label: 'Force Reload', role: 'forceReload' as const, accelerator: 'CmdOrCtrl+Shift+R' },
        {
          label: 'Developer Tools',
          role: 'toggleDevTools' as const,
          accelerator: isMac ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
        },
        { type: 'separator' as const },
        { label: 'Reset Zoom', role: 'resetZoom' as const, accelerator: 'CmdOrCtrl+0' },
        { label: 'Zoom In', role: 'zoomIn' as const, accelerator: 'CmdOrCtrl+Plus' },
        { label: 'Zoom Out', role: 'zoomOut' as const, accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' as const },
        {
          label: 'Toggle Fullscreen',
          role: 'togglefullscreen' as const,
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
        },
      ],
    },

    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Log Folder',
          click: () => {
            const logFile = log.transports.file.getFile();
            if (logFile?.path) {
              shell.showItemInFolder(logFile.path);
            }
          },
        },
        {
          label: 'Export Diagnostics...',
          click: async () => {
            const logFile = log.transports.file.getFile();
            const logPath = logFile?.path;

            if (!logPath || !(await fs.pathExists(logPath))) {
              dialog.showErrorBox('Error', 'Log file does not exist');
              return;
            }

            const result = await dialog.showSaveDialog(mainWindow!, {
              title: 'Export Diagnostics Report',
              defaultPath: `scipen-diagnostics-${new Date().toISOString().slice(0, 10)}.log`,
              filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
            });

            if (!result.canceled && result.filePath) {
              try {
                await fs.copy(logPath, result.filePath);
                shell.showItemInFolder(result.filePath);
              } catch (error) {
                dialog.showErrorBox(
                  'Error',
                  `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
              }
            }
          },
        },
        { type: 'separator' },
        {
          label: 'About SciPen Studio',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About SciPen Studio',
              message: 'SciPen Studio',
              detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode.js: ${process.versions.node}`,
            });
          },
        },
      ],
    },
  ];

  log.info(
    '[Main] Setting up application menu with template:',
    JSON.stringify(
      template.map((t) => ({
        label: t.label,
        role: t.role,
        submenuCount: Array.isArray(t.submenu) ? t.submenu.length : 0,
      }))
    )
  );

  try {
    const menu = Menu.buildFromTemplate(template);
    log.info('[Main] Menu built successfully, setting as application menu...');
    Menu.setApplicationMenu(menu);
    log.info('[Main] Application menu set successfully');
    log.info('[Main] Application menu initialized with', template.length, 'top-level items');

    const helpMenu = template.find((item) => item.label === 'Help');
    if (helpMenu?.submenu) {
      log.info('[Main] Help menu has', (helpMenu.submenu as Array<unknown>).length, 'items');
    }
  } catch (error) {
    console.error('[Main] Failed to setup application menu:', error);
    log.error('[Main] Failed to setup application menu:', error);
  }
}

// ====== IPC Handlers ======

function registerIpcHandlers() {
  // All services obtained from ServiceContainer (DI pattern)
  const fileSystemService = getFileSystemService();
  const aiService = getAIService();
  const syncTeXService = getSyncTeXServiceFromContainer();
  const knowledgeService = getKnowledgeService();

  // Getter functions for dependency injection
  const getMainWindow = () => mainWindow;
  const getWindows = () => windows;
  const getOverleafCompiler = () => overleafCompiler;
  const getOverleafFileSystem = () => overleafFileSystem;
  const getLocalReplicaService = () => localReplicaService;
  const setOverleafCompiler = (compiler: IOverleafService | null) => {
    overleafCompiler = compiler;
    if (compiler) {
      overleafFileSystem = createOverleafFileSystemService(compiler);
      // Why: Inject fileSystemService so LocalReplica writes update mtime cache,
      // preventing false positives on external modification detection
      localReplicaService = createLocalReplicaService(
        compiler,
        overleafFileSystem,
        fileSystemService
      );
      setupLocalReplicaEventForwarding(localReplicaService, getMainWindow);
    } else {
      if (localReplicaService) {
        localReplicaService.dispose();
      }
      localReplicaService = null;
      if (overleafFileSystem) {
        overleafFileSystem.dispose();
      }
      overleafFileSystem = null;
    }
  };

  // ====== Register File Handlers ======
  registerFileHandlers({
    fileSystemService,
    getOverleafCompiler,
    getOverleafFileSystem,
    getMainWindow,
    getWindows,
    addRecentProject,
    loadRecentProjects,
  });

  // ====== Register AI Handlers ======
  // Type assertion: MultimodalKnowledgeService implements IKnowledgeService core methods
  registerAIHandlers({
    aiService,
    getKnowledgeService: () =>
      knowledgeService as unknown as import('./services/interfaces').IKnowledgeService,
  });

  // ====== Register Agent Handlers (PDF2LaTeX, Paper2Beamer, Reviewer) ======
  registerAgentHandlers({
    agentService: getAgentService(),
    getMainWindow,
  });

  // ====== Register Compile Handlers ======
  registerCompileHandlers({
    syncTeXService,
  });

  // ====== Register Knowledge Handlers ======
  registerKnowledgeHandlers({
    getKnowledgeService: () =>
      knowledgeService as unknown as import('./services/interfaces').IKnowledgeService,
    getMainWindow,
  });

  setupKnowledgeEventForwarding(
    knowledgeService as unknown as import('./services/interfaces').IKnowledgeService,
    getMainWindow
  );

  // ====== Register Overleaf Handlers ======
  registerOverleafHandlers({
    getOverleafCompiler,
    setOverleafCompiler,
  });

  // ====== Register Local Replica Handlers ======
  registerLocalReplicaHandlers({
    getLocalReplicaService,
    getMainWindow,
  });

  // ====== Register Window Handlers ======
  registerWindowHandlers({
    getMainWindow,
    getWindows,
    createWindow,
  });

  // ====== Register Chat Handlers (Ask Mode) ======
  registerChatHandlers({
    chatOrchestrator: getChatOrchestrator(),
  });

  // ====== Register LSP Handlers ======
  registerLSPHandlers({
    getMainWindow,
  });

  // ====== Register Config/Dialog/Settings Handlers ======
  registerConfigHandlers();
  registerDialogHandlers();
  registerSettingsHandlers();

  // ====== Register Selection Handlers ======
  const selectionService = getSelectionServiceFromContainer();
  registerSelectionHandlers({
    getSelectionService: () => selectionService,
    getKnowledgeService: () =>
      knowledgeService as unknown as import('./services/interfaces').IKnowledgeService,
    getMainWindow,
  });

  // Auto-start selection service if enabled in config
  if (selectionService.isEnabled()) {
    selectionService.start().then((success) => {
      if (success) {
        log.info('[Main] Selection service started automatically');
      } else {
        log.warn('[Main] Selection service failed to start');
      }
    });
  }
}
