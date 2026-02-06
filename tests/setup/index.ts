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
  createMockSyncTeXService,
  createMockOverleafService,
  createMockKnowledgeService,
  createMockCompilerRegistry,
  // Utilities
  resetServiceMocks,
  expectServiceCall,
  // Types
  type MockContainerOptions,
  type MockAIServiceOptions,
  type MockFileSystemServiceOptions,
  type MockSyncTeXServiceOptions,
  type MockOverleafServiceOptions,
  type MockKnowledgeServiceOptions,
  type MockFn,
} from './MockServiceContainer';
