/**
 * @file Zotero DTOs — main / renderer 跨进程的线协议类型
 * @description Settings(API key 字段只暴露布尔存在标记,不传明文)+ 探测 / ping
 *              / 文献条目 / 批注 / 分页参数等 wire types。
 */

export type ZoteroEmbeddingProvider = 'zhipu' | 'aliyun' | 'openai';

/**
 * 返回给 renderer 的 Zotero 设置。**API key 永不以明文经 IPC 传输**,只暴露
 * 「是否已存入 OS keychain」的布尔标记(hasMinerUApiKey / hasEmbeddingApiKey)。
 */
export interface ZoteroSettingsDTO {
  /**
   * 用户是否启用 SciPen 的 Zotero 集成 — 唯一的主开关 gate。
   * 决定 main canonical bib index 是否在启动 / 窗口聚焦时 bootstrap / refresh。
   * wizard 走完 finish() 时置为 true;Settings 页面可一键关闭。
   */
  integrationEnabled: boolean;
  /**
   * 已检测到的 Zotero 数据目录路径。**仅展示字段 + 未来 M2 PDF 读取用**,
   * 不参与启用 gate(那个用 integrationEnabled),不参与通讯(LocalApi / BBT
   * 用固定端口 127.0.0.1:23119)。空字符串表示尚未检测到。
   */
  path: string;
  /**
   * 反映用户在 Zotero 客户端 Settings → Advanced 勾选 "Allow other
   * applications…" 开关的状态(wizard ping 通过后写入)。这是**外部状态镜像**,
   * 不是 SciPen 集成开关 — 用户想停 SciPen 集成应改 integrationEnabled。
   */
  localApiEnabled: boolean;
  /** Embedding 提供商(用于 M3 主动推荐特性)。 */
  embeddingProvider: ZoteroEmbeddingProvider;
  /** M3 主动引用建议面板的主开关。 */
  activeRecommendation: boolean;
  /** OS keychain 中是否已存入 MinerU API token。 */
  hasMinerUApiKey: boolean;
  /** OS keychain 中是否已存入 embedding 提供商 API key。 */
  hasEmbeddingApiKey: boolean;
}

/**
 * 非敏感 Zotero 设置的部分更新载荷。API key 走专用通道
 * (`Zotero_SetMinerUApiKey` 等),不经过这个通用 setter。
 */
export type ZoteroSettingsPatchDTO = Partial<
  Pick<
    ZoteroSettingsDTO,
    'integrationEnabled' | 'path' | 'localApiEnabled' | 'embeddingProvider' | 'activeRecommendation'
  >
>;

/** 自动探测本地 Zotero 安装的结果。 */
export interface ZoteroDetectionResultDTO {
  found: boolean;
  /** 数据目录文件系统路径;仅 `found` 为 true 时存在。 */
  path?: string;
  /** Zotero 版本字符串(如 "7.0.15");仅 found 时存在。 */
  version?: string;
  /**
   * Better BibTeX(BBT)插件是否在线(其 JSON-RPC 端点
   * `localhost:23119/better-bibtex/json-rpc` 可达)。Wizard 第 3 步据此决定
   * 是否提示安装 BBT;BBT 缺失会让引用键退化为 8 字符 Zotero itemKey,但
   * 不阻塞 wizard 完成。
   */
  betterBibTexInstalled?: boolean;
}

/** 探测 Zotero Local API(`localhost:23119`)的结果。 */
export interface ZoteroPingResultDTO {
  ok: boolean;
  /** Zotero 主版本号(7 | 8);仅 ok 时存在。 */
  version?: number;
  /** 人类可读错误信息;仅 !ok 时存在。 */
  error?: string;
}

/**
 * Zotero 库条目在线协议上的最小投影。我们只暴露 IDE 实际消费的字段 —
 * 完整 Zotero item 携带数十个大部分为空的 CSL 槽位,既膨胀 IPC payload
 * 也会让我们跟 Zotero schema 演进强耦合。
 */
export interface ZoteroItemDTO {
  /** Zotero 稳定 itemKey(8 字符)。 */
  itemKey: string;
  /** 条目类型,如 "journalArticle"、"book"、"preprint"。 */
  itemType: string;
  title: string;
  /** 作者姓串接,便于快速展示("Smith, Jones, Liu")。 */
  creatorsLabel?: string;
  /** 从 `date` 字段尽力提取的发表年份。 */
  year?: number;
  /** 摘要 / 备注,用于 hover tooltip。 */
  abstractNote?: string;
  /**
   * BBT 风格的可读 citationKey(Zotero 自身不分配)。由 index 层
   * (Orchestrator 把 BBT 拉来的映射 join 进来)填入,不是 LocalApi 字段。
   */
  citationKey?: string;
  /** `?include=citation` 返回的格式化引用 HTML(尽力)。 */
  citation?: string;
  /** `?include=bib` 返回的格式化参考条目 HTML(尽力)。 */
  bib?: string;
}

/**
 * IDE 使用的 Zotero 批注字段子集。M2 阶段会接入 PDF panel;M1 保留此类型
 * 以保证 LocalApi 客户端表面完整。
 */
export interface ZoteroAnnotationDTO {
  itemKey: string;
  /** 持有该批注的父(附件)条目。 */
  parentItemKey: string;
  annotationType: 'highlight' | 'note' | 'image' | 'ink' | string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
}

export interface ZoteroGetItemsOptionsDTO {
  /** 默认 25,Zotero API 上限 100(我们保守封顶 100)。 */
  limit?: number;
  /** 分页偏移,与 limit 配对。 */
  start?: number;
}
