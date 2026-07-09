/**
 * @file setup/index.ts
 * @description Test setup entry point - exports all mock utilities and test helpers
 * @depends MockServiceContainer
 */

// ====== Mock Service Container & Helpers ======
export {
  // Container
  createMockContainer,
  createMockHandlerDeps,
  ServiceNames,
  ServiceContainer,
  // Individual Mock Factories
  createMockAIService,
  createMockFileSystemService,
  createMockOverleafService,
  createMockCompilerRegistry,
  // Utilities
  resetServiceMocks,
  expectServiceCall,
  // Types
  type MockContainerOptions,
  type MockAIServiceOptions,
  type MockFileSystemServiceOptions,
  type MockOverleafServiceOptions,
  type MockFn,
} from './MockServiceContainer';
