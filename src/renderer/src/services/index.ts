/**
 * @file Renderer Services - Core renderer process services
 * @description Central export hub for renderer service singletons and helpers.
 * @depends FileCache, CommandService, KeybindingService, ThemeService
 */

export {
  fileCache,
  type L1CacheStats,
} from './FileCache';

export {
  getCommandService,
  CommandServiceImpl,
  Commands,
  useCommand,
  useCommandExecutor,
  type CommandHandler,
  type CommandMetadata,
  type CommandExecutionEvent,
  type CommandId,
} from './CommandService';

export {
  getKeybindingService,
  KeybindingServiceImpl,
  ContextKeys,
  useKeybinding,
  useContextKey,
  type Keybinding,
} from './KeybindingService';

export {
  ThemeService,
  ThemeServiceImpl,
  BuiltinThemes,
  useTheme,
  useThemeColor,
  type ThemeMode,
  type ThemeColors,
  type ThemeDefinition,
} from './ThemeService';
