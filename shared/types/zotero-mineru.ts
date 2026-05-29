/**
 * @file zotero-mineru.ts —— MinerU 精解析(档2)的状态/模型类型
 * @description MinerU 云 API 把 Zotero 论文 PDF 解析为结构化 markdown。
 *              解析是分钟级长任务,状态机合并了 MinerU 远端态(pending/running/
 *              converting)与本地端态(uploading/downloading/extracting)。
 */

/** 解析任务状态。idle = 从未解析或已重置。 */
export type MinerUParseState =
  | 'idle'
  | 'uploading' // 本地:申请 URL + PUT 上传 bytes
  | 'pending' // 远端:排队
  | 'running' // 远端:解析中(带 extractedPages/totalPages)
  | 'converting' // 远端:格式转换中
  | 'downloading' // 本地:下载结果 zip
  | 'extracting' // 本地:解压 zip
  | 'done'
  | 'failed';

export interface MinerUParseStatusDTO {
  itemKey: string;
  state: MinerUParseState;
  /** 仅 running 时有效。 */
  extractedPages?: number;
  totalPages?: number;
  /** 仅 failed 时有效:MinerU 错误码(如 A0202 / -60018)或本地哨兵
   * (MINERU_NO_TOKEN / NO_PDF_ATTACHMENT / MINERU_TIMEOUT)。 */
  errorCode?: string;
  errorMessage?: string;
  updatedAt: string;
}

/** MinerU 模型版本。pipeline 稳定(默认),vlm 质量更高但慢。 */
export type MinerUModelVersion = 'pipeline' | 'vlm';
