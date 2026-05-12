import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = {
  bootstrapState: 'ready',
  projectId: '',
  fileId: '',
  rootPath: '',
  botUserId: '',
  overleafProjectId: '',
  overleafDocMap: {},
  overleafServerUrl: '',
};

const editorState = {
  activeTab: null as {
    path: string;
    content: string;
    _id?: string;
  } | null,
};

const projectState = {
  fileTree: null as any,
};

const settingsState = {
  settings: {
    assistant: {
      openclaw: {
        workspaceId: 'workspace-1',
      },
    },
  },
};

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getEditorService: () => ({
    activeTab: editorState.activeTab,
  }),
  getProjectRuntimeContext: () => ({
    state: runtimeState,
    fileId: runtimeState.fileId,
    rootPath: runtimeState.rootPath,
  }),
  getProjectService: () => ({
    fileTree: projectState.fileTree,
  }),
  getSettingsService: () => settingsState,
}));

import {
  buildIMCollaborationMetadata,
  invalidateFrozenSnapshot,
} from '../../../src/renderer/src/utils/im-collaboration';

describe('buildIMCollaborationMetadata', () => {
  beforeEach(() => {
    runtimeState.bootstrapState = 'ready';
    runtimeState.projectId = '';
    runtimeState.fileId = '';
    runtimeState.rootPath = '';
    editorState.activeTab = null;
    projectState.fileTree = null;
    invalidateFrozenSnapshot();
  });

  it('global scope or empty project does not emit collaboration metadata', () => {
    expect(buildIMCollaborationMetadata('conv-1')).toBeUndefined();
  });

  it('IM-only project emits im-local collaboration metadata', () => {
    runtimeState.rootPath = '/workspace/demo';
    editorState.activeTab = {
      path: '/workspace/demo/src/main.tex',
      content: 'hello world',
    };
    projectState.fileTree = {
      name: 'demo',
      path: '/workspace/demo',
      type: 'directory',
      children: [
        {
          name: 'src',
          path: '/workspace/demo/src',
          type: 'directory',
          children: [
            {
              name: 'main.tex',
              path: '/workspace/demo/src/main.tex',
              type: 'file',
            },
          ],
        },
      ],
    };

    const metadata = buildIMCollaborationMetadata('conv-1');

    expect(metadata?.collaboration).toMatchObject({
      provider: 'im-local',
      mode: 'im-local',
      root_path: '/workspace/demo',
      file_path: 'src/main.tex',
      project_name: 'demo',
      workspace_id: 'workspace-1',
      can_collaborate: true,
      capabilities: {
        propose_edit: true,
        collaborative_tree: false,
        collaborative_read: false,
        collaborative_edit: false,
      },
      file_tree: ['src/main.tex'],
      active_file_content: 'hello world',
    });
    expect(metadata?.collaboration?.project_id).toBeUndefined();
    expect(metadata?.collaboration?.file_id).toBeUndefined();
  });

  it('OT project emits ot-project collaboration metadata', () => {
    runtimeState.rootPath = '/workspace/demo';
    runtimeState.projectId = 'project-1';
    runtimeState.fileId = 'file-1';
    editorState.activeTab = {
      path: '/workspace/demo/src/main.tex',
      content: 'section',
      _id: 'file-1',
    };
    projectState.fileTree = {
      name: 'demo',
      path: '/workspace/demo',
      type: 'directory',
      children: [
        {
          name: 'src',
          path: '/workspace/demo/src',
          type: 'directory',
          children: [
            {
              name: 'main.tex',
              path: '/workspace/demo/src/main.tex',
              type: 'file',
            },
          ],
        },
      ],
    };

    const metadata = buildIMCollaborationMetadata('conv-2');

    expect(metadata?.collaboration).toMatchObject({
      provider: 'scipen-ot',
      mode: 'ot-project',
      project_id: 'project-1',
      file_id: 'file-1',
      file_path: 'src/main.tex',
      capabilities: {
        propose_edit: true,
        collaborative_tree: true,
        collaborative_read: true,
        collaborative_edit: true,
      },
    });
  });
});
