/**
 * @file editor-protocol Zod schemas + inferred TS types
 * @description Mirror of `snaca-editor-protocol::{types, messages}`.
 *   All shapes validated at runtime against the Rust source of truth.
 *   TS types are inferred so there's exactly one definition per shape.
 *
 *   Field names match the wire (snake_case) — we deliberately do NOT
 *   camelCase-translate here. Renderer-facing IPC layer can do that
 *   translation if desired, but the protocol layer stays wire-shaped
 *   for grep-friendly debugging.
 *
 * @see docs/editor-protocol.md
 */

import { z } from 'zod';

// ============ Shared primitives ============

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const LineHunkSchema = z.object({
  hunk_id: z.string().min(1),
  range: RangeSchema,
  old_text: z.string(),
  new_text: z.string(),
});
export type LineHunk = z.infer<typeof LineHunkSchema>;

// ============ Project / context ============

export const ProjectTypeSchema = z.enum(['latex', 'typst', 'mixed']);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

export const MentionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string(), inline_content: z.string().optional() }),
  z.object({ kind: z.literal('folder'), path: z.string() }),
  z.object({ kind: z.literal('symbol'), path: z.string(), name: z.string(), range: RangeSchema }),
  z.object({ kind: z.literal('selection'), path: z.string(), range: RangeSchema, text: z.string() }),
  z.object({ kind: z.literal('url'), url: z.string().url(), content: z.string().optional() }),
]);
export type Mention = z.infer<typeof MentionSchema>;

export const DiagnosticSeveritySchema = z.enum(['error', 'warning', 'info']);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DiagnosticItemSchema = z.object({
  path: z.string(),
  severity: DiagnosticSeveritySchema,
  message: z.string(),
  range: RangeSchema.optional(),
});
export type DiagnosticItem = z.infer<typeof DiagnosticItemSchema>;

export const SelectionInfoSchema = z.object({
  range: RangeSchema,
  text: z.string(),
});
export type SelectionInfo = z.infer<typeof SelectionInfoSchema>;

export const ActiveFileContextSchema = z.object({
  path: z.string(),
  language: z.string(),
  cursor: z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() }).optional(),
  visible_range: z
    .object({ start_line: z.number().int().nonnegative(), end_line: z.number().int().nonnegative() })
    .optional(),
  selection: SelectionInfoSchema.optional(),
  dirty: z.boolean().optional(),
});
export type ActiveFileContext = z.infer<typeof ActiveFileContextSchema>;

export const OpenTabSchema = z.object({ path: z.string(), dirty: z.boolean() });
export type OpenTab = z.infer<typeof OpenTabSchema>;

export const RecentEditSchema = z.object({
  path: z.string(),
  ts: z.string(),
  summary: z.string(),
});
export type RecentEdit = z.infer<typeof RecentEditSchema>;

export const ProjectMetaSchema = z.object({
  type: ProjectTypeSchema,
  main_file: z.string().optional(),
  engine: z.string().optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const ChatContextSchema = z.object({
  active_file: ActiveFileContextSchema.optional(),
  open_tabs: z.array(OpenTabSchema).optional(),
  recent_edits: z.array(RecentEditSchema).optional(),
  mentions: z.array(MentionSchema).optional(),
  diagnostics: z.array(DiagnosticItemSchema).optional(),
  project: ProjectMetaSchema.optional(),
  /**
   * Free-form markdown summarising project-level intel (documentclass /
   * packages / macros / current section / content window / last compile /
   * etc.). Forwarded verbatim into the LLM system prompt by SNACA.
   * Cap at 8KB to keep prompt budget predictable.
   */
  project_intel: z.string().max(8192).optional(),
  /** 右栏正在查看的 Zotero 论文 itemKey。 */
  active_zotero_item: z.string().max(64).optional(),
  /** markdown 预览当前章节标题(scroll-spy)。 */
  markdown_section: z.string().max(256).optional(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

export const InlineEditContextSchema = z.object({
  surrounding_before: z.string(),
  surrounding_after: z.string(),
  language: z.string(),
  project_type: ProjectTypeSchema.optional(),
});
export type InlineEditContext = z.infer<typeof InlineEditContextSchema>;

export const AttachmentSchema = z.object({
  kind: z.enum(['file', 'image']),
  path: z.string().optional(),
  base64: z.string().optional(),
  mime_type: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// ============ Capabilities ============

export const UiSurfaceSchema = z.enum(['chat', 'inline_edit', 'composer']);
export type UiSurface = z.infer<typeof UiSurfaceSchema>;

export const ContextKindSchema = z.enum([
  'active_file',
  'selection',
  'cursor',
  'visible_range',
  'open_tabs',
  'recent_edits',
  'diagnostics',
  'project_meta',
]);
export type ContextKind = z.infer<typeof ContextKindSchema>;

export const EditApplyStrategySchema = z.enum(['host_applies', 'snaca_applies']);
export type EditApplyStrategy = z.infer<typeof EditApplyStrategySchema>;

export const ApprovalUiSchema = z.enum(['local_card', 'passthrough']);
export type ApprovalUi = z.infer<typeof ApprovalUiSchema>;

export const ApprovalModeKindSchema = z.enum(['interactive', 'auto_allow', 'auto_deny']);
export type ApprovalModeKind = z.infer<typeof ApprovalModeKindSchema>;

export const ContextRequestKindSchema = z.enum([
  'flush_unsaved',
  'file_content',
  'zotero_search',
  'zotero_lookup',
  'zotero_annotations',
  'zotero_read',
]);
export type ContextRequestKind = z.infer<typeof ContextRequestKindSchema>;

export const MemoryEmbedderKindSchema = z.enum(['none', 'hash', 'fastembed']);
export type MemoryEmbedderKind = z.infer<typeof MemoryEmbedderKindSchema>;

export const FramingKindSchema = z.enum(['ndjson', 'content_length']);
export type FramingKind = z.infer<typeof FramingKindSchema>;

export const SnacaCapabilitiesSchema = z.object({
  protocol_version: z.string(),
  engine_version: z.string(),
  streaming_text: z.boolean().default(false),
  streaming_thinking: z.boolean().default(false),
  streaming_edit: z.boolean().default(false),
  inline_edit: z.boolean().default(false),
  composer: z.boolean().default(false),
  context_request: z.array(ContextRequestKindSchema).default([]),
  tools_builtin: z.array(z.string()).default([]),
  approval_modes: z.array(ApprovalModeKindSchema).default([]),
  memory_embedders: z.array(MemoryEmbedderKindSchema).default([]),
  framing: z.array(FramingKindSchema).default([]),
});
export type SnacaCapabilities = z.infer<typeof SnacaCapabilitiesSchema>;

export const HostCapabilitiesSchema = z.object({
  ui_surfaces: z.array(UiSurfaceSchema),
  context_kinds: z.array(ContextKindSchema),
  edit_apply_strategy: EditApplyStrategySchema,
  approval_ui: ApprovalUiSchema,
  framing: z.array(FramingKindSchema).default([]),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

// ============ SnacaConfig ============

export const LlmProviderSchema = z.enum(['deepseek', 'anthropic', 'openai_compatible']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const RetryConfigSchema = z.object({
  max_attempts: z.number().int().positive(),
  base_delay_ms: z.number().int().nonnegative(),
  max_delay_secs: z.number().int().nonnegative(),
  jitter_ratio: z.number().nonnegative(),
});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export const LlmConfigSchema = z.object({
  provider: LlmProviderSchema,
  api_key_env: z.string().min(1),
  model: z.string().min(1),
  inline_edit_model: z.string().optional(),
  base_url: z.string().optional(),
  timeout_secs: z.number().int().positive().optional(),
  retry: RetryConfigSchema.optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const EngineConfigSchema = z.object({
  max_iterations: z.number().int().positive().optional(),
  loop_guard_max_repeats: z.number().int().positive().optional(),
  concurrent_tool_limit: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  history_limit: z.number().int().positive().optional(),
  compact_after_input_tokens: z.number().int().positive().optional(),
  compact_keep_recent: z.number().int().positive().optional(),
  protect_first_n: z.number().int().nonnegative().optional(),
  compact_max_retries: z.number().int().nonnegative().optional(),
  system_prompt: z.string().optional(),
  memory_extractor: z.boolean().optional(),
  memory_extractor_model: z.string().optional(),
  compact_summary_max_tokens: z.number().int().positive().optional(),
  history_max_bytes: z.number().int().positive().optional(),
  // 0 means "disabled" — schema accepts >=0 and lets the sidecar interpret.
  turn_timeout_secs: z.number().int().nonnegative().optional(),
  collapse_tool_results_threshold: z.number().int().nonnegative().optional(),
  stream_tool_execution: z.boolean().optional(),
  max_output_token_escalation_attempts: z.number().int().nonnegative().optional(),
  max_output_token_ceiling: z.number().int().positive().optional(),
  // 0 keeps MCP clients alive forever / disables the reaper.
  mcp_idle_ttl_secs: z.number().int().nonnegative().optional(),
  mcp_reaper_period_secs: z.number().int().nonnegative().optional(),
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const ApprovalModeSchema = z.enum(['interactive', 'auto_allow', 'auto_deny']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const McpTransportSchema = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: McpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  init_timeout_secs: z.number().int().positive().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const LoggingConfigSchema = z.object({
  filter: z.string().optional(),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const SnacaConfigSchema = z.object({
  llm: LlmConfigSchema,
  engine: EngineConfigSchema.optional().default({}),
  approval_mode: ApprovalModeSchema,
  mcp_servers: z.array(McpServerConfigSchema).optional(),
  logging: LoggingConfigSchema.optional(),
  bundled_skills_dir: z.string().optional(),
});
export type SnacaConfig = z.infer<typeof SnacaConfigSchema>;

// ============ Lifecycle messages ============

export const HostInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

export const InitParamsSchema = z.object({
  protocol_version: z.string(),
  host: HostInfoSchema,
  snaca_config: SnacaConfigSchema,
  host_caps: HostCapabilitiesSchema,
});
export type InitParams = z.infer<typeof InitParamsSchema>;

export const InitResultSchema = z.object({
  protocol_version: z.string(),
  engine_version: z.string(),
  capabilities: SnacaCapabilitiesSchema,
});
export type InitResult = z.infer<typeof InitResultSchema>;

export const ShutdownResultSchema = z.object({ ok: z.boolean() });
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;

export const HealthPingResultSchema = z.object({
  pong: z.boolean(),
  engine_uptime_secs: z.number().int().nonnegative(),
});
export type HealthPingResult = z.infer<typeof HealthPingResultSchema>;

export const ConfigReloadResultSchema = z.object({
  applied: z.boolean(),
  restart_required: z.boolean(),
});
export type ConfigReloadResult = z.infer<typeof ConfigReloadResultSchema>;

// ============ Session messages ============

export const ThreadSummarySchema = z.object({
  thread_id: z.string().min(1),
  title: z.string(),
  created_at: z.string(),
  last_active_at: z.string(),
  turn_count: z.number().int().nonnegative(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const SessionOpenParamsSchema = z.object({
  project_id: z.string().min(1),
  workspace_root: z.string().min(1),
  metadata_root: z.string().min(1),
  shared_metadata_root: z.string().optional(),
  display_name: z.string(),
  project_type: ProjectTypeSchema,
});
export type SessionOpenParams = z.infer<typeof SessionOpenParamsSchema>;

export const SessionOpenResultSchema = z.object({
  session_id: z.string().min(1),
  active_thread_id: z.string().min(1),
  threads: z.array(ThreadSummarySchema),
});
export type SessionOpenResult = z.infer<typeof SessionOpenResultSchema>;

export const SessionDeleteThreadResultSchema = z.object({
  deleted: z.boolean(),
  /** Guaranteed non-empty: SNACA auto-creates a fresh thread if the deleted one was the last. */
  active_thread_id: z.string().min(1),
});
export type SessionDeleteThreadResult = z.infer<typeof SessionDeleteThreadResultSchema>;

export const SessionListThreadsResultSchema = z.object({
  threads: z.array(ThreadSummarySchema),
  total: z.number().int().nonnegative(),
});
export type SessionListThreadsResult = z.infer<typeof SessionListThreadsResultSchema>;

export const SessionNewThreadResultSchema = z.object({
  thread_id: z.string().min(1),
  title: z.string(),
});
export type SessionNewThreadResult = z.infer<typeof SessionNewThreadResultSchema>;

export const SessionSwitchThreadResultSchema = z.object({
  switched: z.boolean(),
  thread: ThreadSummarySchema,
});
export type SessionSwitchThreadResult = z.infer<typeof SessionSwitchThreadResultSchema>;

export const ThreadMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  ts: z.string(),
  /** Turn that produced this message (assistant messages from a chat /
   *  inline_edit / composer turn). Studio uses it to re-attach thinking
   *  trace / tool calls / edit proposals from IndexedDB cache. */
  turn_id: z.string().optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const SessionGetMessagesResultSchema = z.object({
  messages: z.array(ThreadMessageSchema),
  total: z.number().int().nonnegative(),
});
export type SessionGetMessagesResult = z.infer<typeof SessionGetMessagesResultSchema>;

// ============ Chat / inline_edit / composer ============

export const ChatSendParamsSchema = z.object({
  session_id: z.string().min(1),
  thread_id: z.string().min(1),
  content: z.string(),
  context: ChatContextSchema,
  attachments: z.array(AttachmentSchema).optional(),
});
export type ChatSendParams = z.infer<typeof ChatSendParamsSchema>;

export const ChatSendResultSchema = z.object({ turn_id: z.string().min(1) });
export type ChatSendResult = z.infer<typeof ChatSendResultSchema>;

export const InlineEditStartParamsSchema = z.object({
  session_id: z.string().min(1),
  thread_id: z.string().optional(),
  file: z.string().min(1),
  range: RangeSchema,
  instruction: z.string().min(1),
  context: InlineEditContextSchema,
});
export type InlineEditStartParams = z.infer<typeof InlineEditStartParamsSchema>;

export const InlineEditStartResultSchema = z.object({
  turn_id: z.string().min(1),
  proposal_id: z.string().min(1),
});
export type InlineEditStartResult = z.infer<typeof InlineEditStartResultSchema>;

export const ComposerModeSchema = z.enum(['plan_first', 'immediate']);
export type ComposerMode = z.infer<typeof ComposerModeSchema>;

export const ComposerStartParamsSchema = z.object({
  session_id: z.string().min(1),
  thread_id: z.string().min(1),
  instruction: z.string().min(1),
  mentions: z.array(MentionSchema).default([]),
  context: ChatContextSchema,
  mode: ComposerModeSchema,
  scope: z.object({ paths: z.array(z.string()) }).optional(),
});
export type ComposerStartParams = z.infer<typeof ComposerStartParamsSchema>;

export const ComposerStartResultSchema = z.object({ turn_id: z.string().min(1) });
export type ComposerStartResult = z.infer<typeof ComposerStartResultSchema>;

export const PlanDecisionSchema = z.enum(['accept', 'reject', 'modify']);
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

export const PlanConfirmParamsSchema = z.object({
  turn_id: z.string().min(1),
  decision: PlanDecisionSchema,
  modifications: z
    .object({
      add_files: z.array(z.string()).default([]),
      remove_files: z.array(z.string()).default([]),
      note: z.string().optional(),
    })
    .optional(),
});
export type PlanConfirmParams = z.infer<typeof PlanConfirmParamsSchema>;

export const PlanConfirmResultSchema = z.object({ ok: z.boolean() });
export type PlanConfirmResult = z.infer<typeof PlanConfirmResultSchema>;

// ============ Turn deltas (streamed from SNACA) ============

export const DoneReasonSchema = z.enum(['completed', 'cancelled', 'error']);
export type DoneReason = z.infer<typeof DoneReasonSchema>;

export const TurnDeltaKindSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({
    kind: z.literal('tool_use'),
    tool_call_id: z.string().min(1),
    tool: z.string().min(1),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_progress'),
    tool_call_id: z.string().min(1),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    tool_call_id: z.string().min(1),
    ok: z.boolean(),
    content: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('done'),
    reason: DoneReasonSchema,
    cancelled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.number().int(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
]);
export type TurnDeltaKind = z.infer<typeof TurnDeltaKindSchema>;

/**
 * `turn.delta` is encoded with `kind` flattened at the top level alongside
 * `turn_id` and `seq`. We parse the whole envelope first then split out
 * the kind.
 */
export const TurnDeltaParamsSchema = z.intersection(
  z.object({
    turn_id: z.string().min(1),
    seq: z.number().int().nonnegative(),
  }),
  TurnDeltaKindSchema
);
export type TurnDeltaParams = z.infer<typeof TurnDeltaParamsSchema>;

export const TurnCancelParamsSchema = z.object({
  turn_id: z.string().min(1),
  reason: z.string().optional(),
});
export type TurnCancelParams = z.infer<typeof TurnCancelParamsSchema>;

// ============ Edit propose / confirm ============

export const EditProposeParamsSchema = z.object({
  proposal_id: z.string().min(1),
  turn_id: z.string().min(1),
  tool_call_id: z.string().optional(),
  file: z.string().min(1),
  base_hash: z.string().min(1),
  hunks: z.array(LineHunkSchema),
  streaming: z.boolean(),
  summary: z.string().optional(),
  expected_post_hash: z.string().optional(),
});
export type EditProposeParams = z.infer<typeof EditProposeParamsSchema>;

export const EditProposeDeltaParamsSchema = z.object({
  proposal_id: z.string().min(1),
  hunk_id: z.string().min(1),
  append_text: z.string(),
  done: z.boolean().optional(),
});
export type EditProposeDeltaParams = z.infer<typeof EditProposeDeltaParamsSchema>;

export const EditProposeCompleteParamsSchema = z.object({
  proposal_id: z.string().min(1),
  final_hunks: z.array(LineHunkSchema),
});
export type EditProposeCompleteParams = z.infer<typeof EditProposeCompleteParamsSchema>;

export const EditDecisionSchema = z.enum(['accept', 'reject', 'accept_partial']);
export type EditDecision = z.infer<typeof EditDecisionSchema>;

export const PerHunkChoiceSchema = z.enum(['accept', 'reject']);
export type PerHunkChoice = z.infer<typeof PerHunkChoiceSchema>;

export const EditConfirmParamsSchema = z.object({
  proposal_id: z.string().min(1),
  decision: EditDecisionSchema,
  per_hunk: z.array(z.object({ hunk_id: z.string(), decision: PerHunkChoiceSchema })).optional(),
  modified_text: z.array(z.object({ hunk_id: z.string(), new_text: z.string() })).optional(),
});
export type EditConfirmParams = z.infer<typeof EditConfirmParamsSchema>;

export const EditConfirmResultSchema = z.object({
  applied: z.boolean(),
  applied_hash: z.string().optional(),
  errors: z.array(z.object({ hunk_id: z.string(), message: z.string() })).optional(),
});
export type EditConfirmResult = z.infer<typeof EditConfirmResultSchema>;

// ============ Tool approval ============

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ToolApprovalRequestParamsSchema = z.object({
  tool_call_id: z.string().min(1),
  turn_id: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown(),
  summary: z.string(),
  risk: RiskLevelSchema,
  default_decision: z.enum(['allow', 'deny']).optional(),
  timeout_secs: z.number().int().positive().optional(),
});
export type ToolApprovalRequestParams = z.infer<typeof ToolApprovalRequestParamsSchema>;

export const ToolDecisionSchema = z.enum(['allow', 'deny', 'allow_always', 'deny_always']);
export type ToolDecision = z.infer<typeof ToolDecisionSchema>;

export const ToolConfirmParamsSchema = z.object({
  tool_call_id: z.string().min(1),
  decision: ToolDecisionSchema,
});
export type ToolConfirmParams = z.infer<typeof ToolConfirmParamsSchema>;

// ============ Plan update ============

export const PlanFileActionSchema = z.enum(['create', 'modify', 'delete', 'rename']);
export type PlanFileAction = z.infer<typeof PlanFileActionSchema>;

export const PlanFileStatusSchema = z.enum(['pending', 'in_progress', 'done', 'rejected', 'failed']);
export type PlanFileStatus = z.infer<typeof PlanFileStatusSchema>;

export const PlanFileSchema = z.object({
  path: z.string(),
  action: PlanFileActionSchema,
  rename_to: z.string().optional(),
  summary: z.string(),
  status: PlanFileStatusSchema,
});
export type PlanFile = z.infer<typeof PlanFileSchema>;

export const PlanUpdateParamsSchema = z.object({
  turn_id: z.string().min(1),
  awaiting: z.boolean(),
  files: z.array(PlanFileSchema),
  rationale: z.string(),
});
export type PlanUpdateParams = z.infer<typeof PlanUpdateParamsSchema>;

// ============ Context request / respond ============

export const ContextRequestPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flush_unsaved'),
    params: z.object({ paths: z.array(z.string()).optional() }),
  }),
  z.object({
    kind: z.literal('file_content'),
    params: z.object({ path: z.string() }),
  }),
  // ----- Zotero-backed context kinds (M1) -----
  // SNACA tools use these to query the host's Zotero index without
  // standing up a separate MCP server. The renderer owns the actual
  // data (ZoteroBibIndex + LocalAPI cache); host forwards request to
  // the active window and parks the reply until the renderer responds
  // (or the 5s timeout fires).
  z.object({
    kind: z.literal('zotero_search'),
    params: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
    }),
  }),
  z.object({
    kind: z.literal('zotero_lookup'),
    params: z.object({
      // Either a BBT citation key or an 8-char Zotero itemKey;
      // resolver tries both forms.
      key: z.string().min(1),
    }),
  }),
  z.object({
    kind: z.literal('zotero_annotations'),
    params: z.object({ item_key: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('zotero_read'),
    params: z.object({ key: z.string().min(1) }),
  }),
]);
export type ContextRequestPayload = z.infer<typeof ContextRequestPayloadSchema>;

export const ContextRequestParamsSchema = z.intersection(
  z.object({
    request_id: z.string().min(1),
    turn_id: z.string().min(1),
  }),
  ContextRequestPayloadSchema
);
export type ContextRequestParams = z.infer<typeof ContextRequestParamsSchema>;

export const ContextPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flush_unsaved'),
    flushed_files: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('file_content'),
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
  }),
  // ----- Zotero response payloads (M1) -----
  z.object({
    kind: z.literal('zotero_search'),
    results: z.array(
      z.object({
        item_key: z.string(),
        citation_key: z.string().optional(),
        title: z.string().optional(),
        creators_label: z.string().optional(),
        year: z.number().int().optional(),
        score: z.number(),
      })
    ),
  }),
  z.object({
    kind: z.literal('zotero_lookup'),
    found: z.boolean(),
    item: z
      .object({
        item_key: z.string(),
        citation_key: z.string().optional(),
        title: z.string().optional(),
        creators_label: z.string().optional(),
        year: z.number().int().optional(),
        abstract: z.string().optional(),
        // BBT CSL JSON is opaque; we pass it through as a raw object so
        // SNACA tools can extract any field they need.
        csl: z.unknown().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('zotero_annotations'),
    annotations: z.array(
      z.object({
        item_key: z.string(),
        parent_item_key: z.string(),
        annotation_type: z.string(),
        text: z.string().optional(),
        comment: z.string().optional(),
        color: z.string().optional(),
        page_label: z.string().optional(),
      })
    ),
  }),
  z.object({
    kind: z.literal('zotero_read'),
    text: z.string(),
    truncated: z.boolean(),
    tier: z.enum(['local', 'none', 'mineru']),
    quality: z.enum(['good', 'poor']).optional(),
  }),
]);
export type ContextPayload = z.infer<typeof ContextPayloadSchema>;

export const ContextRespondParamsSchema = z.object({
  request_id: z.string().min(1),
  ok: z.boolean(),
  payload: ContextPayloadSchema.optional(),
  error: z.string().optional(),
});
export type ContextRespondParams = z.infer<typeof ContextRespondParamsSchema>;

// ============ Usage / memory / error / log ============

export const UsageTotalsSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  thinking_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageUpdateParamsSchema = z.object({
  turn_id: z.string().min(1),
  cumulative: UsageTotalsSchema,
});
export type UsageUpdateParams = z.infer<typeof UsageUpdateParamsSchema>;

export const MemoryScopeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryActionSchema = z.enum(['created', 'updated', 'deleted']);
export type MemoryAction = z.infer<typeof MemoryActionSchema>;

export const MemoryUpdatedParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema,
  name: z.string(),
  action: MemoryActionSchema,
});
export type MemoryUpdatedParams = z.infer<typeof MemoryUpdatedParamsSchema>;

// ============ memory.* RPC ============

export const MemoryEntrySummarySchema = z.object({
  scope: MemoryScopeSchema,
  name: z.string(),
  last_modified: z.string(),
  preview: z.string(),
});
export type MemoryEntrySummary = z.infer<typeof MemoryEntrySummarySchema>;

export const MemoryListParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema.optional(),
});
export type MemoryListParams = z.infer<typeof MemoryListParamsSchema>;

export const MemoryListResultSchema = z.object({
  entries: z.array(MemoryEntrySummarySchema),
});
export type MemoryListResult = z.infer<typeof MemoryListResultSchema>;

export const MemoryGetParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema,
  name: z.string().min(1),
});
export type MemoryGetParams = z.infer<typeof MemoryGetParamsSchema>;

export const MemoryGetResultSchema = z.object({
  scope: MemoryScopeSchema,
  name: z.string(),
  content: z.string(),
  last_modified: z.string(),
});
export type MemoryGetResult = z.infer<typeof MemoryGetResultSchema>;

export const MemoryWriteParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema,
  name: z.string().min(1),
  content: z.string(),
});
export type MemoryWriteParams = z.infer<typeof MemoryWriteParamsSchema>;

export const MemoryWriteResultSchema = z.object({
  action: MemoryActionSchema,
});
export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

export const MemoryDeleteParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema,
  name: z.string().min(1),
});
export type MemoryDeleteParams = z.infer<typeof MemoryDeleteParamsSchema>;

export const MemoryDeleteResultSchema = z.object({
  deleted: z.boolean(),
});
export type MemoryDeleteResult = z.infer<typeof MemoryDeleteResultSchema>;

export const MemoryRevealParamsSchema = z.object({
  session_id: z.string().min(1),
  scope: MemoryScopeSchema.optional(),
  name: z.string().optional(),
});
export type MemoryRevealParams = z.infer<typeof MemoryRevealParamsSchema>;

export const MemoryRevealResultSchema = z.object({
  path: z.string(),
});
export type MemoryRevealResult = z.infer<typeof MemoryRevealResultSchema>;

// ============ skills.* RPC ============

export const SkillScopeSchema = z.enum(['bundled', 'global', 'tenant', 'project']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillSummarySchema = z.object({
  scope: SkillScopeSchema,
  name: z.string(),
  description: z.string().optional(),
  when_to_use: z.string().optional(),
  allowed_tools: z.array(z.string()).default([]),
  source_path: z.string(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillDetailSchema = SkillSummarySchema.extend({
  body: z.string(),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillsListParamsSchema = z.object({
  session_id: z.string().min(1),
});
export type SkillsListParams = z.infer<typeof SkillsListParamsSchema>;

export const SkillsListResultSchema = z.object({
  skills: z.array(SkillSummarySchema),
});
export type SkillsListResult = z.infer<typeof SkillsListResultSchema>;

export const SkillsGetParamsSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1),
});
export type SkillsGetParams = z.infer<typeof SkillsGetParamsSchema>;

export const SkillsGetResultSchema = z.object({
  skill: SkillDetailSchema,
});
export type SkillsGetResult = z.infer<typeof SkillsGetResultSchema>;

export const SkillsReloadParamsSchema = z.object({
  session_id: z.string().min(1),
});
export type SkillsReloadParams = z.infer<typeof SkillsReloadParamsSchema>;

export const SkillsReloadResultSchema = z.object({
  reloaded: z.boolean(),
});
export type SkillsReloadResult = z.infer<typeof SkillsReloadResultSchema>;

export const ErrorNotificationParamsSchema = z.object({
  turn_id: z.string().optional(),
  session_id: z.string().optional(),
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
  recoverable: z.boolean(),
});
export type ErrorNotificationParams = z.infer<typeof ErrorNotificationParamsSchema>;

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogWriteParamsSchema = z.object({
  level: LogLevelSchema,
  target: z.string(),
  message: z.string(),
  ts: z.string(),
  fields: z.unknown().optional(),
});
export type LogWriteParams = z.infer<typeof LogWriteParamsSchema>;
