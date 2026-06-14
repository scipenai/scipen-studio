/**
 * @file HistoryService - L1 + L2 history API for scipen-studio.
 *
 * M1 stub: surface only — every method throws so consumers fail loudly until
 * M4 wires real storage. The constructor accepts its dependencies (BlobStore +
 * config) so DI registration in M5 needs no rework.
 */

import { createLogger } from '../LoggerService';
import { BlobStore } from './BlobStore';
import type {
  CreateLabelInput,
  IHistoryService,
  RecordChunkInput,
  RecordChunkResult,
  RecordStepInput,
} from './interfaces/IHistoryService';
import { DEFAULT_HISTORY_CONFIG, type HistoryChunk, type HistoryConfig, type HistoryLabel, type HistoryStep } from './types';

const logger = createLogger('HistoryService');

export interface HistoryServiceDeps {
  blobStore: BlobStore;
  config?: Partial<HistoryConfig>;
}

export class HistoryService implements IHistoryService {
  private readonly config: HistoryConfig;

  constructor(private readonly deps: HistoryServiceDeps) {
    this.config = { ...DEFAULT_HISTORY_CONFIG, ...(deps.config ?? {}) };
    void this.deps;
    void this.config;
    logger.debug('HistoryService stub constructed (M1)');
  }

  recordChunk(_input: RecordChunkInput): Promise<RecordChunkResult> {
    throw new Error('HistoryService.recordChunk not implemented yet (M4)');
  }

  listChunks(_projectId: string, _fileId: string, _limit?: number): Promise<HistoryChunk[]> {
    throw new Error('HistoryService.listChunks not implemented yet (M4)');
  }

  createLabel(_input: CreateLabelInput): Promise<HistoryLabel> {
    throw new Error('HistoryService.createLabel not implemented yet (M4)');
  }

  listLabels(_projectId: string, _limit?: number): Promise<HistoryLabel[]> {
    throw new Error('HistoryService.listLabels not implemented yet (M4)');
  }

  resolveLabelSnapshot(_labelId: string): Promise<Map<string, Uint8Array>> {
    throw new Error('HistoryService.resolveLabelSnapshot not implemented yet (M4)');
  }

  recordStep(_input: RecordStepInput): Promise<HistoryStep> {
    throw new Error('HistoryService.recordStep not implemented yet (M4)');
  }

  getStep(_hashHex: string): Promise<HistoryStep | null> {
    throw new Error('HistoryService.getStep not implemented yet (M4)');
  }

  listSessionSteps(_sessionId: string, _limit?: number): Promise<HistoryStep[]> {
    throw new Error('HistoryService.listSessionSteps not implemented yet (M4)');
  }

  async dispose(): Promise<void> {
    await this.deps.blobStore.dispose();
  }
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  return new HistoryService(deps);
}
