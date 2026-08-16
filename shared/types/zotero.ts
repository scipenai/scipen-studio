/**
 * @file Zotero DTOs — main / renderer 跨进程的线协议类型
 * @description Settings(API key 字段只暴露布尔存在标记,不传明文)+ 探测 / ping
 *              / 文献条目 / 批注 / 分页参数等 wire types。
 */

export type ZoteroEmbeddingProvider = 'zhipu' | 'aliyun' | 'openai';

/**
 * Zotero 数据源模式(二选一):
 *   - `local`(默认)= 走本地 Zotero 客户端 LocalApi(`127.0.0.1:23119`)+ BBT
 *   - `web`         = 走 zotero.org Web API(`https://api.zotero.org`)
 * 阶段 A 内不并存,`ZoteroOrchestrator.getActiveClient()` 严格按此字段路由。
 */
export type ZoteroDataSource = 'local' | 'web';

/**
 * Citation key 归一化来源。`bbt` = 用户曾装 BBT 并同步到云;`studio_mint` =
 * 本地 minter 生成;`user_override` = 用户在 studio 内手改。UI 分组显示 + BBT
 * 后接管 override 时用。
 */
export type ZoteroCitationKeyOrigin = 'bbt' | 'studio_mint' | 'user_override';

/**
 * 返回给 renderer 的 Zotero 设置。**API key 永不以明文经 IPC 传输**,只暴露
 * 「是否已存入 OS keychain」的布尔标记(hasMinerUApiKey / hasEmbeddingApiKey /
 * hasWebApiKey)。
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
  /**
   * 数据源:`local` 走本地 Zotero + BBT;`web` 走 api.zotero.org。默认 `local`。
   * 切换会触发 orchestrator refresh + client 重建。web mode 下 BBT / MinerU
   * (阶段 A)不可用。
   */
  dataSource: ZoteroDataSource;
  /**
   * zotero.org Web API 用户 numeric ID(如 "123456")。仅在 dataSource='web'
   * 生效;由用户在 Settings 手填。空字符串 = 未配置。
   */
  webApiUserId: string;
  /** OS keychain 中是否已存入 Zotero Web API key。 */
  hasWebApiKey: boolean;
  /**
   * `references.bib` 自动同步配置。M2 加入:订阅 main 的 canonical 索引,
   * 用 BBT export 把全库写到项目 root 的 `.bib` 文件,让 LaTeX/biber 编译能找到。
   */
  bibTexSync: BibTexSyncConfigDTO;
}

/** `references.bib` 自动同步的设置项。 */
export interface BibTexSyncConfigDTO {
  enabled: boolean;
  /** 项目 root 下的目标文件名。默认 'references.bib'。 */
  fileName: string;
  /** BBT translator 名;'BetterBibLaTeX'(默认) / 'BetterBibTeX' / 'BibLaTeX' / 'BibTeX'。 */
  translator: string;
}

/**
 * 非敏感 Zotero 设置的部分更新载荷。API key 走专用通道
 * (`Zotero_SetMinerUApiKey` 等),不经过这个通用 setter。
 */
export type ZoteroSettingsPatchDTO = Partial<
  Pick<
    ZoteroSettingsDTO,
    | 'integrationEnabled'
    | 'path'
    | 'localApiEnabled'
    | 'embeddingProvider'
    | 'activeRecommendation'
    | 'bibTexSync'
    | 'dataSource'
    | 'webApiUserId'
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
 * 探测 Zotero Web API(`api.zotero.org`)的结果 —— userId + apiKey 有效性 +
 * 用户名回显。Settings 里 "Test connection" 按钮消费此结果。
 */
export interface ZoteroWebApiPingResultDTO {
  ok: boolean;
  /** 云端返回的 username(如 "alice");仅 ok 时存在。 */
  username?: string;
  /**
   * 分类错误信息;仅 !ok 时存在。与 `ZoteroWebApiClient.ping()` +
   * `ZoteroDiscoveryService.probeWebApi()` 里的实际映射保持同步:
   *   - 输入校验失败(空 userId / apiKey)→ "Zotero user ID/API key is required"
   *   - 401 Unauthorized                  → "API key invalid or expired"
   *   - 403 Forbidden                     → "API key lacks required permissions"
   *   - 404 Not Found                     → "Zotero user ID not found"
   *   - 429 Too Many Requests             → "Rate limited by Zotero API; try again shortly"
   *   - 其他 HTTP 非 2xx                   → "Zotero Web API returned HTTP {status}"
   *   - 网络 / DNS / 超时                 → "Cannot reach api.zotero.org (network or DNS issue)"
   *   - 构造 client 异常                   → "Probe failed: {reason}"
   */
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
  /**
   * citationKey 来源(web mode 下的 3 层 fallback)。omit 表示 local mode
   * 且用 8-char itemKey 兜底(未走归一化路径)。
   */
  citationKeyOrigin?: ZoteroCitationKeyOrigin;
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

/**
 * 论文正文抽取结果(文本来源档位)。
 *   - `local`             = pdf-parse 原始抽取(公式/表格可能乱序,LLM 应知保真度有限)
 *   - `none`              = 该条目无 PDF 附件 / 不可读
 *   - `mineru`(预留)     = M2-b 的结构化 MD
 *   - `web_pending`       = 数据源是 Web API,PDF 在云端未本地缓存;stage B 加 lazy
 *                           download + LRU 后可用。LLM 应知"不是没全文,是暂不支持"
 *                           而非做出"该文献无内容"的错误推断。
 */
export interface ZoteroFullTextResultDTO {
  text: string;
  /** 超出字节上限被截断(尾部带 `[...truncated]`)。 */
  truncated: boolean;
  tier: 'local' | 'none' | 'mineru' | 'web_pending';
  /**
   * 档1(`local`)抽取的可读性自检结论。`poor` = 大量乱码/空白(扫描版、
   * 公式密集、字体无 ToUnicode),LLM 应据此判断别逐字引用、建议升档解析;
   * `good` = 正常正文。`mineru` 恒为 `good`,`none` / `web_pending` 不带。
   */
  quality?: 'good' | 'poor';
}

/**
 * Zotero 附件条目投影。用于解析一个父条目下的 PDF 附件 → 本地文件路径
 * (全文抽取的前提)。`linkMode` 决定文件定位方式:
 *   - `imported_file` / `imported_url` → 文件在 `{dataDir}/storage/{key}/{filename}`
 *   - `linked_file` → 文件在 `path`(绝对路径,用户自管)
 */
export interface ZoteroAttachmentDTO {
  itemKey: string;
  contentType?: string;
  filename?: string;
  linkMode?: string;
  /** linked_file 模式下的绝对路径;其余模式为 undefined。 */
  path?: string;
}
