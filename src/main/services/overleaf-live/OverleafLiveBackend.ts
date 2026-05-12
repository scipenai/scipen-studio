import type {
  OverleafLiveConfigureParams,
  OverleafLiveConnectionStateDTO,
  OverleafLiveDocStateDTO,
  OverleafLiveEntityResultDTO,
  OverleafLiveErrorDTO,
  OverleafLiveRemotePatchDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveSubmitPatchesParams,
  OverleafLiveTreeChangedDTO,
  OverleafLiveCreateEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveJoinDocParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveRenameEntityParams,
  OverleafLiveUploadFileParams,
} from '../../../../shared/api-types';
import type { IDisposable } from '../ServiceContainer';

export interface OverleafLiveBackendObserver {
  handleConnectionChanged(payload: OverleafLiveConnectionStateDTO): void;
  handleStateChanged(payload: OverleafLiveStateChangedDTO): void;
  handleRemotePatch(payload: OverleafLiveRemotePatchDTO): void;
  handleTreeChanged(payload: OverleafLiveTreeChangedDTO): void;
  handleError(payload: OverleafLiveErrorDTO): void;
}

export interface OverleafLiveBackend extends IDisposable {
  configure(config: OverleafLiveConfigureParams): Promise<OverleafLiveConnectionStateDTO>;
  disconnect(): void;
  getState(): OverleafLiveStateChangedDTO;
  getLastConfigureError(): string | null;
  /** True when the session is live (sessionId is not null). */
  hasActiveSession(): boolean;
  /** True when the given project is configured and its session is live. */
  isConfiguredForProject(projectId: string): boolean;
  getProjectSnapshot(projectId: string): Promise<{ projectId: string; project: unknown } | null>;
  joinDoc(params: OverleafLiveJoinDocParams): Promise<OverleafLiveDocStateDTO>;
  submitPatches(params: OverleafLiveSubmitPatchesParams): Promise<OverleafLiveRemotePatchDTO>;
  createEntity(params: OverleafLiveCreateEntityParams): Promise<OverleafLiveEntityResultDTO>;
  renameEntity(params: OverleafLiveRenameEntityParams): Promise<OverleafLiveEntityResultDTO>;
  moveEntity(params: OverleafLiveMoveEntityParams): Promise<OverleafLiveEntityResultDTO>;
  deleteEntity(params: OverleafLiveDeleteEntityParams): Promise<OverleafLiveEntityResultDTO>;
  uploadFile(params: OverleafLiveUploadFileParams): Promise<OverleafLiveEntityResultDTO>;
}
