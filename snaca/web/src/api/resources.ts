import { api } from "./client";

export type StatusResponse = {
  version: string;
  uptime_seconds: number;
  started_at: string;
  tenant_id: string;
  llm_provider: string;
  llm_model: string;
  plugin_count: number;
  mcp_server_count: number;
};

export type ConfigFileResponse = {
  path: string;
  toml: string;
  restart_required: boolean;
};

export type UpdateConfigFileResponse = {
  path: string;
  restart_required: boolean;
};

export type ShutdownResponse = {
  accepted: boolean;
  reason: string;
};

export type PluginStatus = {
  name: string;
  command: string;
  args: string[];
  started_at: string;
  reload_count: number;
  manifest_version: string;
  manifest_capabilities: unknown;
};

export type ThreadSummary = {
  id: string;
  tenant_id: string;
  project_id: string;
  created_at: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export type MessageDto = {
  id: string;
  thread_id: string;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  created_at: string;
};

export type DecisionDto = {
  tenant_id: string;
  project_id: string;
  tool_name: string;
  input_signature: string;
  decision: "allow" | "deny";
  decided_at: string;
};

export type ScheduledTaskDto = {
  id: string;
  tenant_id: string;
  project_id: string;
  chat_id: string;
  plugin: string;
  prompt: string;
  interval_secs: number | null;
  next_fire_at: string;
  last_fired_at: string | null;
  enabled: boolean;
  created_at: string;
};

export type CreateScheduleInput = {
  tenant_id: string;
  project_id: string;
  chat_id: string;
  plugin: string;
  prompt: string;
  interval_secs?: number | null;
  next_fire_at: string;
};

export type OutboxDto = {
  id: string;
  plugin: string;
  tenant_id: string;
  chat_id: string;
  kind: string;
  attempts: number;
  next_attempt_at: string;
  status: "pending" | "delivered" | "failed";
  last_error: string | null;
  platform_message_id: string | null;
  created_at: string;
  delivered_at: string | null;
};

export const status = () => api.get<StatusResponse>("/status");
export const config = () => api.get<Record<string, unknown>>("/config");
export const configFile = () => api.get<ConfigFileResponse>("/config/file");
export const updateConfigFile = (toml: string) =>
  api.put<UpdateConfigFileResponse>("/config/file", { toml });
export const shutdownSystem = () =>
  api.post<ShutdownResponse>("/system/shutdown");

export const listPlugins = () =>
  api.get<{ plugins: PluginStatus[] }>("/plugins");
export const reloadPlugin = (name: string) =>
  api.post<{ status: string; plugin: PluginStatus }>(
    `/plugins/${encodeURIComponent(name)}/reload`,
  );

export const listTenants = () => api.get<{ tenants: string[] }>("/tenants");
export const listProjects = (tenant: string) =>
  api.get<{ projects: string[] }>(
    `/tenants/${encodeURIComponent(tenant)}/projects`,
  );
export const listThreads = (tenant: string, project: string) =>
  api.get<{ threads: ThreadSummary[] }>(
    `/projects/${encodeURIComponent(tenant)}/${encodeURIComponent(project)}/threads`,
  );
export const listMessages = (id: string, opts?: { before?: string }) => {
  const q = new URLSearchParams();
  if (opts?.before) q.set("before", opts.before);
  const suffix = q.toString();
  return api.get<{ messages: MessageDto[] }>(
    `/threads/${encodeURIComponent(id)}/messages${suffix ? `?${suffix}` : ""}`,
  );
};
export const abortThread = (id: string) =>
  api.post<{ aborted: boolean; count: number }>(
    `/threads/${encodeURIComponent(id)}/abort`,
  );

export const listDecisions = (filters: { tenant?: string; project?: string } = {}) => {
  const q = new URLSearchParams();
  if (filters.tenant) q.set("tenant", filters.tenant);
  if (filters.project) q.set("project", filters.project);
  const suffix = q.toString();
  return api.get<{ decisions: DecisionDto[] }>(
    `/approvals${suffix ? `?${suffix}` : ""}`,
  );
};
export const forgetDecision = (params: {
  tenant: string;
  project: string;
  tool: string;
  input_signature: string;
}) => {
  const q = new URLSearchParams({
    tenant: params.tenant,
    project: params.project,
    tool: params.tool,
    input_signature: params.input_signature,
  });
  return api.delete<void>(`/approvals?${q.toString()}`);
};

export const listSchedules = (enabledOnly = false) =>
  api.get<{ schedules: ScheduledTaskDto[] }>(
    `/schedules${enabledOnly ? "?enabled_only=true" : ""}`,
  );
export const createSchedule = (body: CreateScheduleInput) =>
  api.post<ScheduledTaskDto>("/schedules", body);
export const setScheduleEnabled = (id: string, enabled: boolean) =>
  api.patch<{ id: string; enabled: boolean }>(
    `/schedules/${encodeURIComponent(id)}/enabled`,
    { enabled },
  );
export const deleteSchedule = (id: string) =>
  api.delete<void>(`/schedules/${encodeURIComponent(id)}`);

export const listOutbox = (filter: { status?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.limit) q.set("limit", String(filter.limit));
  const suffix = q.toString();
  return api.get<{ outbox: OutboxDto[] }>(
    `/outbox${suffix ? `?${suffix}` : ""}`,
  );
};
export const retryOutbox = (id: string) =>
  api.post<{ id: string; requeued: boolean }>(
    `/outbox/${encodeURIComponent(id)}/retry`,
  );
