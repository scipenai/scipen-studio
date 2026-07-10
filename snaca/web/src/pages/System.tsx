import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

type FormState = {
  httpListen: string;
  dataRoot: string;
  tenantId: string;
  typingUpdateIntervalMs: string;
  mcpIdleTtlSecs: string;
  mcpReaperPeriodSecs: string;
  llmProvider: string;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  llmTimeoutSecs: string;
  llmAnthropicVersion: string;
  llmRetryMaxAttempts: string;
  llmRetryBaseDelayMs: string;
  llmRetryMaxDelaySecs: string;
  llmRetryJitterRatio: string;
  adminEnabled: boolean;
  adminToken: string;
  corsOrigins: string;
  tavilyApiKey: string;
  maxIterations: string;
  maxTokens: string;
  historyLimit: string;
  historyMaxBytes: string;
  turnTimeoutSecs: string;
  concurrentToolLimit: string;
  collapseToolResultsThreshold: string;
  streamToolExecution: boolean;
  streamInterruptedMaxRetries: string;
  loopGuardMaxRepeats: string;
  malformedToolArgsMaxRetries: string;
  maxOutputTokenEscalationAttempts: string;
  maxOutputTokenCeiling: string;
  systemPrompt: string;
  compactAfterInputTokens: string;
  compactKeepRecent: string;
  protectFirstN: string;
  compactMaxRetries: string;
  compactSummaryMaxTokens: string;
  memoryExtractor: boolean;
  memoryExtractorModel: string;
  memoryExtractorNoFilter: boolean;
  memoryWriteApproval: boolean;
  skillsGlobalDir: string;
  loggingFilter: string;
  loggingFile: string;
  loggingMaxSizeMb: string;
  loggingMaxFiles: string;
};

type PluginForm = {
  name: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
};

type McpForm = {
  name: string;
  transport: string;
  command: string;
  args: string;
  cwd: string;
  initTimeoutSecs: string;
  callTimeoutSecs: string;
  env: string;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-ink-700 dark:bg-ink-950 dark:text-ink-50";
const labelClass = "text-xs font-medium text-ink-600 dark:text-ink-300";

export function System() {
  const { t } = useTranslation();
  const fetcher = useCallback(() => R.configFile(), []);
  const { data, error, loading, refresh } = useApi(fetcher);
  const [toml, setToml] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);

  useEffect(() => {
    if (data) {
      setToml(data.toml);
      setSaveError(null);
    }
  }, [data]);

  const form = useMemo(() => formFromToml(toml), [toml]);
  const plugins = useMemo(() => pluginsFromToml(toml), [toml]);
  const mcpServers = useMemo(() => mcpFromToml(toml), [toml]);
  const dirty = data ? toml !== data.toml : false;

  const updateField = (field: keyof FormState, value: string | boolean) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) => applyFormField(current, field, value));
  };

  const updateToml = (value: string) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml(value);
  };

  const updatePlugin = (index: number, patch: Partial<PluginForm>) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) => {
      const next = pluginsFromToml(current);
      next[index] = { ...next[index], ...patch };
      return replaceArrayBlocks(current, "plugins", next.map(pluginToToml));
    });
  };

  const addPlugin = () => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) =>
      replaceArrayBlocks(current, "plugins", [
        ...pluginsFromToml(current).map(pluginToToml),
        pluginToToml({
          name: "lark",
          command: "./target/debug/snaca-plugin-lark",
          args: "",
          cwd: "",
          env: "",
        }),
      ]),
    );
  };

  const removePlugin = (index: number) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) => {
      const next = pluginsFromToml(current);
      next.splice(index, 1);
      return replaceArrayBlocks(current, "plugins", next.map(pluginToToml));
    });
  };

  const updateMcp = (index: number, patch: Partial<McpForm>) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) => {
      const next = mcpFromToml(current);
      next[index] = { ...next[index], ...patch };
      return replaceArrayBlocks(current, "mcp", next.map(mcpToToml));
    });
  };

  const addMcp = () => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) =>
      replaceArrayBlocks(current, "mcp", [
        ...mcpFromToml(current).map(mcpToToml),
        mcpToToml({
          name: "filesystem",
          transport: "stdio",
          command: "npx",
          args: "-y\n@modelcontextprotocol/server-filesystem\n/some/path",
          cwd: "",
          initTimeoutSecs: "",
          callTimeoutSecs: "",
          env: "",
        }),
      ]),
    );
  };

  const removeMcp = (index: number) => {
    setSaveError(null);
    setSaveStatus(null);
    setToml((current) => {
      const next = mcpFromToml(current);
      next.splice(index, 1);
      return replaceArrayBlocks(current, "mcp", next.map(mcpToToml));
    });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveStatus(null);
    try {
      const result = await R.updateConfigFile(toml);
      await refresh();
      setSaveStatus(
        result.restart_required
          ? t("system.saved_restart")
          : t("system.saved"),
      );
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const shutdown = async () => {
    if (!window.confirm(t("system.shutdown_confirm"))) return;
    setShuttingDown(true);
    setSaveError(null);
    setSaveStatus(null);
    try {
      await R.shutdownSystem();
      setSaveStatus(t("system.shutdown_requested"));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setShuttingDown(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
            {t("system.title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            {t("system.subtitle")}
          </p>
          {data?.path && (
            <p className="mt-1 text-xs text-ink-400 dark:text-ink-500">
              {data.path}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              if (data) {
                updateToml(data.toml);
              }
            }}
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
          >
            <RotateCcw className="size-4" />
            {t("system.reset")}
          </Button>
          <Button onClick={() => void refresh()} variant="ghost" size="sm">
            <RefreshCw className="size-4" />
            {t("common.refresh")}
          </Button>
          <Button
            onClick={() => void save()}
            variant="primary"
            size="sm"
            disabled={!dirty || saving || loading}
          >
            <Save className="size-4" />
            {saving ? t("system.saving") : t("system.save")}
          </Button>
          <Button
            onClick={() => void shutdown()}
            variant="danger"
            size="sm"
            disabled={shuttingDown}
          >
            {shuttingDown ? t("system.shutting_down") : t("system.shutdown")}
          </Button>
        </div>
      </header>

      {(error || saveError || saveStatus) && (
        <div
          className={
            error || saveError
              ? "rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
              : "rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
          }
        >
          {error || saveError || saveStatus}
        </div>
      )}

      {data?.restart_required && !dirty && !saveStatus && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          {t("system.restart_pending")}
        </div>
      )}

      {loading && !data ? (
        <Card>
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
          <div className="space-y-6">
            <Card
              title={t("system.core")}
              description={t("system.core_desc")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label={t("system.http_listen")} value={form.httpListen} onChange={(v) => updateField("httpListen", v)} hint={t("system.help.http_listen")} />
                <TextField label={t("system.data_root")} value={form.dataRoot} onChange={(v) => updateField("dataRoot", v)} hint={t("system.help.data_root")} />
                <TextField label={t("system.tenant_id")} value={form.tenantId} onChange={(v) => updateField("tenantId", v)} hint={t("system.help.tenant_id")} />
                <TextField label={t("system.skills_global_dir")} value={form.skillsGlobalDir} onChange={(v) => updateField("skillsGlobalDir", v)} placeholder="./skills-global" hint={t("system.help.skills_global_dir")} />
                <TextField label={t("system.typing_update_interval_ms")} value={form.typingUpdateIntervalMs} onChange={(v) => updateField("typingUpdateIntervalMs", v)} inputMode="numeric" placeholder="200" hint={t("system.help.typing_update_interval_ms")} />
                <TextField label={t("system.mcp_idle_ttl_secs")} value={form.mcpIdleTtlSecs} onChange={(v) => updateField("mcpIdleTtlSecs", v)} inputMode="numeric" placeholder="600" hint={t("system.help.mcp_idle_ttl_secs")} />
                <TextField label={t("system.mcp_reaper_period_secs")} value={form.mcpReaperPeriodSecs} onChange={(v) => updateField("mcpReaperPeriodSecs", v)} inputMode="numeric" placeholder="60" hint={t("system.help.mcp_reaper_period_secs")} />
              </div>
            </Card>

            <Card title={t("system.llm")} description={t("system.llm_desc")}>
              <div className="grid gap-4 md:grid-cols-2">
                <SelectField
                  label={t("system.provider")}
                  value={form.llmProvider}
                  onChange={(v) => updateField("llmProvider", v)}
                  options={["deepseek", "anthropic"]}
                  hint={t("system.help.provider")}
                />
                <TextField label={t("system.model")} value={form.llmModel} onChange={(v) => updateField("llmModel", v)} hint={t("system.help.model")} />
                <TextField label={t("system.api_key")} value={form.llmApiKey} onChange={(v) => updateField("llmApiKey", v)} placeholder="${DEEPSEEK_API_KEY}" hint={t("system.help.api_key")} />
                <TextField label={t("system.base_url")} value={form.llmBaseUrl} onChange={(v) => updateField("llmBaseUrl", v)} placeholder="https://api.deepseek.com" hint={t("system.help.base_url")} />
                <TextField label={t("system.timeout_secs")} value={form.llmTimeoutSecs} onChange={(v) => updateField("llmTimeoutSecs", v)} inputMode="numeric" hint={t("system.help.timeout_secs")} />
                <TextField label={t("system.tavily_api_key")} value={form.tavilyApiKey} onChange={(v) => updateField("tavilyApiKey", v)} placeholder="${TAVILY_API_KEY}" hint={t("system.help.tavily_api_key")} />
                <TextField label={t("system.anthropic_version")} value={form.llmAnthropicVersion} onChange={(v) => updateField("llmAnthropicVersion", v)} placeholder="2023-06-01" hint={t("system.help.anthropic_version")} />
                <TextField label={t("system.retry_max_attempts")} value={form.llmRetryMaxAttempts} onChange={(v) => updateField("llmRetryMaxAttempts", v)} inputMode="numeric" placeholder="5" hint={t("system.help.retry_max_attempts")} />
                <TextField label={t("system.retry_base_delay_ms")} value={form.llmRetryBaseDelayMs} onChange={(v) => updateField("llmRetryBaseDelayMs", v)} inputMode="numeric" placeholder="500" hint={t("system.help.retry_base_delay_ms")} />
                <TextField label={t("system.retry_max_delay_secs")} value={form.llmRetryMaxDelaySecs} onChange={(v) => updateField("llmRetryMaxDelaySecs", v)} inputMode="numeric" placeholder="30" hint={t("system.help.retry_max_delay_secs")} />
                <TextField label={t("system.retry_jitter_ratio")} value={form.llmRetryJitterRatio} onChange={(v) => updateField("llmRetryJitterRatio", v)} placeholder="0.5" hint={t("system.help.retry_jitter_ratio")} />
              </div>
            </Card>

            <Card
              title={t("system.engine")}
              description={t("system.engine_desc")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label={t("system.max_iterations")} value={form.maxIterations} onChange={(v) => updateField("maxIterations", v)} inputMode="numeric" hint={t("system.help.max_iterations")} />
                <TextField label={t("system.max_tokens")} value={form.maxTokens} onChange={(v) => updateField("maxTokens", v)} inputMode="numeric" hint={t("system.help.max_tokens")} />
                <TextField label={t("system.history_limit")} value={form.historyLimit} onChange={(v) => updateField("historyLimit", v)} inputMode="numeric" hint={t("system.help.history_limit")} />
                <TextField label={t("system.history_max_bytes")} value={form.historyMaxBytes} onChange={(v) => updateField("historyMaxBytes", v)} inputMode="numeric" placeholder="1572864" hint={t("system.help.history_max_bytes")} />
                <TextField label={t("system.turn_timeout_secs")} value={form.turnTimeoutSecs} onChange={(v) => updateField("turnTimeoutSecs", v)} inputMode="numeric" hint={t("system.help.turn_timeout_secs")} />
                <TextField label={t("system.concurrent_tool_limit")} value={form.concurrentToolLimit} onChange={(v) => updateField("concurrentToolLimit", v)} inputMode="numeric" placeholder="5" hint={t("system.help.concurrent_tool_limit")} />
                <TextField label={t("system.collapse_tool_results_threshold")} value={form.collapseToolResultsThreshold} onChange={(v) => updateField("collapseToolResultsThreshold", v)} inputMode="numeric" placeholder="1024" hint={t("system.help.collapse_tool_results_threshold")} />
                <TextField label={t("system.loop_guard_max_repeats")} value={form.loopGuardMaxRepeats} onChange={(v) => updateField("loopGuardMaxRepeats", v)} inputMode="numeric" placeholder="3" hint={t("system.help.loop_guard_max_repeats")} />
                <TextField label={t("system.malformed_tool_args_max_retries")} value={form.malformedToolArgsMaxRetries} onChange={(v) => updateField("malformedToolArgsMaxRetries", v)} inputMode="numeric" placeholder="2" hint={t("system.help.malformed_tool_args_max_retries")} />
                <TextField label={t("system.stream_interrupted_max_retries")} value={form.streamInterruptedMaxRetries} onChange={(v) => updateField("streamInterruptedMaxRetries", v)} inputMode="numeric" placeholder="2" hint={t("system.help.stream_interrupted_max_retries")} />
                <TextField label={t("system.max_output_token_escalation_attempts")} value={form.maxOutputTokenEscalationAttempts} onChange={(v) => updateField("maxOutputTokenEscalationAttempts", v)} inputMode="numeric" placeholder="2" hint={t("system.help.max_output_token_escalation_attempts")} />
                <TextField label={t("system.max_output_token_ceiling")} value={form.maxOutputTokenCeiling} onChange={(v) => updateField("maxOutputTokenCeiling", v)} inputMode="numeric" placeholder="32768" hint={t("system.help.max_output_token_ceiling")} />
                <ToggleField label={t("system.stream_tool_execution")} checked={form.streamToolExecution} onChange={(v) => updateField("streamToolExecution", v)} hint={t("system.help.stream_tool_execution")} />
                <div className="md:col-span-2">
                  <TextAreaField label={t("system.system_prompt")} value={form.systemPrompt} onChange={(v) => updateField("systemPrompt", v)} rows={4} placeholder={t("system.system_prompt_ph")} hint={t("system.help.system_prompt")} />
                </div>
              </div>
            </Card>

            <Card
              title={t("system.compaction")}
              description={t("system.compaction_desc")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label={t("system.compact_after_input_tokens")} value={form.compactAfterInputTokens} onChange={(v) => updateField("compactAfterInputTokens", v)} inputMode="numeric" hint={t("system.help.compact_after_input_tokens")} />
                <TextField label={t("system.compact_keep_recent")} value={form.compactKeepRecent} onChange={(v) => updateField("compactKeepRecent", v)} inputMode="numeric" placeholder="6" hint={t("system.help.compact_keep_recent")} />
                <TextField label={t("system.protect_first_n")} value={form.protectFirstN} onChange={(v) => updateField("protectFirstN", v)} inputMode="numeric" placeholder="4" hint={t("system.help.protect_first_n")} />
                <TextField label={t("system.compact_max_retries")} value={form.compactMaxRetries} onChange={(v) => updateField("compactMaxRetries", v)} inputMode="numeric" placeholder="3" hint={t("system.help.compact_max_retries")} />
                <TextField label={t("system.compact_summary_max_tokens")} value={form.compactSummaryMaxTokens} onChange={(v) => updateField("compactSummaryMaxTokens", v)} inputMode="numeric" placeholder="2048" hint={t("system.help.compact_summary_max_tokens")} />
              </div>
            </Card>

            <Card
              title={t("system.memory")}
              description={t("system.memory_desc")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label={t("system.memory_extractor_model")} value={form.memoryExtractorModel} onChange={(v) => updateField("memoryExtractorModel", v)} hint={t("system.help.memory_extractor_model")} />
                <ToggleField label={t("system.memory_extractor")} checked={form.memoryExtractor} onChange={(v) => updateField("memoryExtractor", v)} hint={t("system.help.memory_extractor")} />
                <ToggleField label={t("system.memory_extractor_no_filter")} checked={form.memoryExtractorNoFilter} onChange={(v) => updateField("memoryExtractorNoFilter", v)} hint={t("system.help.memory_extractor_no_filter")} />
                <ToggleField label={t("system.memory_write_approval")} checked={form.memoryWriteApproval} onChange={(v) => updateField("memoryWriteApproval", v)} hint={t("system.help.memory_write_approval")} />
              </div>
            </Card>

            <Card title={t("system.admin")} description={t("system.admin_desc")}>
              <div className="grid gap-4 md:grid-cols-2">
                <ToggleField label={t("system.admin_enabled")} checked={form.adminEnabled} onChange={(v) => updateField("adminEnabled", v)} hint={t("system.help.admin_enabled")} />
                <TextField label={t("system.admin_token")} value={form.adminToken} onChange={(v) => updateField("adminToken", v)} hint={t("system.help.admin_token")} />
                <TextAreaField label={t("system.cors_origins")} value={form.corsOrigins} onChange={(v) => updateField("corsOrigins", v)} rows={3} placeholder="http://127.0.0.1:5173" hint={t("system.help.cors_origins")} />
              </div>
            </Card>

            <Card title={t("system.logging")}>
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label={t("system.logging_filter")} value={form.loggingFilter} onChange={(v) => updateField("loggingFilter", v)} placeholder="info,snaca_llm=debug" hint={t("system.help.logging_filter")} />
                <TextField label={t("system.logging_file")} value={form.loggingFile} onChange={(v) => updateField("loggingFile", v)} placeholder="./logs/snaca.log" hint={t("system.help.logging_file")} />
                <TextField label={t("system.logging_max_size_mb")} value={form.loggingMaxSizeMb} onChange={(v) => updateField("loggingMaxSizeMb", v)} inputMode="numeric" placeholder="50" hint={t("system.help.logging_max_size_mb")} />
                <TextField label={t("system.logging_max_files")} value={form.loggingMaxFiles} onChange={(v) => updateField("loggingMaxFiles", v)} inputMode="numeric" placeholder="10" hint={t("system.help.logging_max_files")} />
              </div>
            </Card>

            <Card
              title={t("system.plugins_config")}
              description={t("system.plugins_config_desc")}
            >
              <div className="space-y-4">
                {plugins.length === 0 ? (
                  <div className="rounded-md border border-dashed border-ink-300 px-3 py-4 text-sm text-ink-500 dark:border-ink-700 dark:text-ink-400">
                    {t("system.no_plugins_configured")}
                  </div>
                ) : (
                  plugins.map((plugin, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-ink-200 p-4 dark:border-ink-800"
                    >
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">
                          {plugin.name || t("system.unnamed_plugin")}
                        </div>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => removePlugin(index)}
                        >
                          <Trash2 className="size-4" />
                          {t("system.remove")}
                        </Button>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField label={t("system.name")} value={plugin.name} onChange={(v) => updatePlugin(index, { name: v })} />
                        <TextField label={t("system.command")} value={plugin.command} onChange={(v) => updatePlugin(index, { command: v })} hint={t("system.help.plugin_command")} />
                        <TextField label={t("system.cwd")} value={plugin.cwd} onChange={(v) => updatePlugin(index, { cwd: v })} placeholder="./plugins/lark" hint={t("system.help.cwd")} />
                        <TextAreaField label={t("system.args_lines")} value={plugin.args} onChange={(v) => updatePlugin(index, { args: v })} rows={3} placeholder="--flag&#10;value" hint={t("system.help.args_lines")} />
                        <div className="md:col-span-2">
                          <TextAreaField label={t("system.env_lines")} value={plugin.env} onChange={(v) => updatePlugin(index, { env: v })} rows={4} placeholder="LARK_APP_ID=cli_xxx&#10;LARK_APP_SECRET=xxx" hint={t("system.help.env_lines")} />
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <Button type="button" variant="secondary" size="sm" onClick={addPlugin}>
                  <Plus className="size-4" />
                  {t("system.add_plugin")}
                </Button>
              </div>
            </Card>

            <Card
              title={t("system.mcp_config")}
              description={t("system.mcp_config_desc")}
            >
              <div className="space-y-4">
                {mcpServers.length === 0 ? (
                  <div className="rounded-md border border-dashed border-ink-300 px-3 py-4 text-sm text-ink-500 dark:border-ink-700 dark:text-ink-400">
                    {t("system.no_mcp_configured")}
                  </div>
                ) : (
                  mcpServers.map((server, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-ink-200 p-4 dark:border-ink-800"
                    >
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">
                          {server.name || t("system.unnamed_mcp")}
                        </div>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => removeMcp(index)}
                        >
                          <Trash2 className="size-4" />
                          {t("system.remove")}
                        </Button>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField label={t("system.name")} value={server.name} onChange={(v) => updateMcp(index, { name: v })} />
                        <SelectField label={t("system.transport")} value={server.transport} onChange={(v) => updateMcp(index, { transport: v })} options={["stdio", "http"]} hint={t("system.help.transport")} />
                        <TextField label={t("system.command")} value={server.command} onChange={(v) => updateMcp(index, { command: v })} hint={t("system.help.mcp_command")} />
                        <TextField label={t("system.cwd")} value={server.cwd} onChange={(v) => updateMcp(index, { cwd: v })} hint={t("system.help.cwd")} />
                        <TextField label={t("system.init_timeout_secs")} value={server.initTimeoutSecs} onChange={(v) => updateMcp(index, { initTimeoutSecs: v })} inputMode="numeric" hint={t("system.help.init_timeout_secs")} />
                        <TextField label={t("system.call_timeout_secs")} value={server.callTimeoutSecs} onChange={(v) => updateMcp(index, { callTimeoutSecs: v })} inputMode="numeric" hint={t("system.help.call_timeout_secs")} />
                        <TextAreaField label={t("system.args_lines")} value={server.args} onChange={(v) => updateMcp(index, { args: v })} rows={3} placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/some/path" hint={t("system.help.args_lines")} />
                        <TextAreaField label={t("system.env_lines")} value={server.env} onChange={(v) => updateMcp(index, { env: v })} rows={3} placeholder="TOKEN=xxx" hint={t("system.help.env_lines")} />
                      </div>
                    </div>
                  ))
                )}
                <Button type="button" variant="secondary" size="sm" onClick={addMcp}>
                  <Plus className="size-4" />
                  {t("system.add_mcp")}
                </Button>
              </div>
            </Card>
          </div>

          <Card title={t("system.full_toml")} description={t("system.full_toml_desc")}>
            <textarea
              className="min-h-[72vh] w-full resize-y rounded-md border border-ink-200 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-50 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/30 dark:border-ink-700"
              spellCheck={false}
              value={toml}
              onChange={(e) => updateToml(e.target.value)}
            />
          </Card>
        </div>
      )}
    </div>
  );
}

const hintClass = "mt-1 block text-[11px] font-normal leading-snug text-ink-400 dark:text-ink-500";

function FieldHint({ hint }: { hint?: string }) {
  if (!hint) return null;
  return <span className={hintClass}>{hint}</span>;
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric";
  hint?: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        className={fieldClass}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldHint hint={hint} />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      <textarea
        className={fieldClass}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldHint hint={hint} />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  hint?: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      <select
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <FieldHint hint={hint} />
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="text-xs font-medium text-ink-600 dark:text-ink-300">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          className="size-4 rounded border-ink-300 text-indigo-600 focus:ring-indigo-500"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <FieldHint hint={hint} />
    </div>
  );
}

function formFromToml(toml: string): FormState {
  return {
    httpListen: getString(toml, "server", "http_listen") ?? "127.0.0.1:8080",
    dataRoot: getString(toml, "server", "data_root") ?? "./data",
    tenantId: getString(toml, "tenant", "id") ?? "default",
    typingUpdateIntervalMs: getScalar(toml, "server", "typing_update_interval_ms") ?? "",
    mcpIdleTtlSecs: getScalar(toml, "server", "mcp_idle_ttl_secs") ?? "",
    mcpReaperPeriodSecs: getScalar(toml, "server", "mcp_reaper_period_secs") ?? "",
    llmProvider: getString(toml, "llm", "provider") ?? "deepseek",
    llmApiKey: getString(toml, "llm", "api_key") ?? "",
    llmModel: getString(toml, "llm", "model") ?? "deepseek-chat",
    llmBaseUrl: getString(toml, "llm", "base_url") ?? "",
    llmTimeoutSecs: getScalar(toml, "llm", "timeout_secs") ?? "",
    llmAnthropicVersion: getString(toml, "llm", "anthropic_version") ?? "",
    llmRetryMaxAttempts: getScalar(toml, "llm", "retry_max_attempts") ?? "",
    llmRetryBaseDelayMs: getScalar(toml, "llm", "retry_base_delay_ms") ?? "",
    llmRetryMaxDelaySecs: getScalar(toml, "llm", "retry_max_delay_secs") ?? "",
    llmRetryJitterRatio: getScalar(toml, "llm", "retry_jitter_ratio") ?? "",
    adminEnabled: getBoolean(toml, "admin", "enabled") ?? false,
    adminToken: getString(toml, "admin", "token") ?? "",
    corsOrigins: getArrayStrings(toml, "admin", "cors_origins").join("\n"),
    tavilyApiKey: getString(toml, "web", "tavily_api_key") ?? "",
    maxIterations: getScalar(toml, "engine", "max_iterations") ?? "",
    maxTokens: getScalar(toml, "engine", "max_tokens") ?? "",
    historyLimit: getScalar(toml, "engine", "history_limit") ?? "",
    historyMaxBytes: getScalar(toml, "engine", "history_max_bytes") ?? "",
    turnTimeoutSecs: getScalar(toml, "engine", "turn_timeout_secs") ?? "",
    concurrentToolLimit: getScalar(toml, "engine", "concurrent_tool_limit") ?? "",
    collapseToolResultsThreshold: getScalar(toml, "engine", "collapse_tool_results_threshold") ?? "",
    streamToolExecution: getBoolean(toml, "engine", "stream_tool_execution") ?? true,
    streamInterruptedMaxRetries: getScalar(toml, "engine", "stream_interrupted_max_retries") ?? "",
    loopGuardMaxRepeats: getScalar(toml, "engine", "loop_guard_max_repeats") ?? "",
    malformedToolArgsMaxRetries: getScalar(toml, "engine", "malformed_tool_args_max_retries") ?? "",
    maxOutputTokenEscalationAttempts: getScalar(toml, "engine", "max_output_token_escalation_attempts") ?? "",
    maxOutputTokenCeiling: getScalar(toml, "engine", "max_output_token_ceiling") ?? "",
    systemPrompt: getString(toml, "engine", "system_prompt") ?? "",
    compactAfterInputTokens: getScalar(toml, "engine", "compact_after_input_tokens") ?? "",
    compactKeepRecent: getScalar(toml, "engine", "compact_keep_recent") ?? "",
    protectFirstN: getScalar(toml, "engine", "protect_first_n") ?? "",
    compactMaxRetries: getScalar(toml, "engine", "compact_max_retries") ?? "",
    compactSummaryMaxTokens: getScalar(toml, "engine", "compact_summary_max_tokens") ?? "",
    memoryExtractor: getBoolean(toml, "engine", "memory_extractor") ?? true,
    memoryExtractorModel: getString(toml, "engine", "memory_extractor_model") ?? "",
    memoryExtractorNoFilter: getBoolean(toml, "engine", "memory_extractor_no_filter") ?? false,
    memoryWriteApproval: getBoolean(toml, "engine", "memory_write_approval") ?? false,
    skillsGlobalDir: getString(toml, "skills", "global_dir") ?? "",
    loggingFilter: getString(toml, "logging", "filter") ?? "",
    loggingFile: getString(toml, "logging", "file") ?? "",
    loggingMaxSizeMb: getScalar(toml, "logging", "max_size_mb") ?? "",
    loggingMaxFiles: getScalar(toml, "logging", "max_files") ?? "",
  };
}

function applyFormField(
  toml: string,
  field: keyof FormState,
  value: string | boolean,
): string {
  switch (field) {
    case "httpListen":
      return setTomlValue(toml, "server", "http_listen", quote(String(value)));
    case "dataRoot":
      return setTomlValue(toml, "server", "data_root", quote(String(value)));
    case "tenantId":
      return setTomlValue(toml, "tenant", "id", quote(String(value)));
    case "typingUpdateIntervalMs":
      return setTomlValue(toml, "server", "typing_update_interval_ms", optionalNumber(value));
    case "mcpIdleTtlSecs":
      return setTomlValue(toml, "server", "mcp_idle_ttl_secs", optionalNumber(value));
    case "mcpReaperPeriodSecs":
      return setTomlValue(toml, "server", "mcp_reaper_period_secs", optionalNumber(value));
    case "llmProvider":
      return setTomlValue(toml, "llm", "provider", quote(String(value)));
    case "llmApiKey":
      return setTomlValue(toml, "llm", "api_key", quote(String(value)));
    case "llmModel":
      return setTomlValue(toml, "llm", "model", quote(String(value)));
    case "llmBaseUrl":
      return setTomlValue(toml, "llm", "base_url", optionalString(value));
    case "llmTimeoutSecs":
      return setTomlValue(toml, "llm", "timeout_secs", optionalNumber(value));
    case "llmAnthropicVersion":
      return setTomlValue(toml, "llm", "anthropic_version", optionalString(value));
    case "llmRetryMaxAttempts":
      return setTomlValue(toml, "llm", "retry_max_attempts", optionalNumber(value));
    case "llmRetryBaseDelayMs":
      return setTomlValue(toml, "llm", "retry_base_delay_ms", optionalNumber(value));
    case "llmRetryMaxDelaySecs":
      return setTomlValue(toml, "llm", "retry_max_delay_secs", optionalNumber(value));
    case "llmRetryJitterRatio":
      return setTomlValue(toml, "llm", "retry_jitter_ratio", optionalNumber(value));
    case "adminEnabled":
      return setTomlValue(toml, "admin", "enabled", String(value));
    case "adminToken":
      return setTomlValue(toml, "admin", "token", quote(String(value)));
    case "corsOrigins":
      return setTomlValue(toml, "admin", "cors_origins", stringArray(String(value)));
    case "tavilyApiKey":
      return setTomlValue(toml, "web", "tavily_api_key", optionalString(value));
    case "maxIterations":
      return setTomlValue(toml, "engine", "max_iterations", optionalNumber(value));
    case "maxTokens":
      return setTomlValue(toml, "engine", "max_tokens", optionalNumber(value));
    case "historyLimit":
      return setTomlValue(toml, "engine", "history_limit", optionalNumber(value));
    case "historyMaxBytes":
      return setTomlValue(toml, "engine", "history_max_bytes", optionalNumber(value));
    case "turnTimeoutSecs":
      return setTomlValue(toml, "engine", "turn_timeout_secs", optionalNumber(value));
    case "concurrentToolLimit":
      return setTomlValue(toml, "engine", "concurrent_tool_limit", optionalNumber(value));
    case "collapseToolResultsThreshold":
      return setTomlValue(toml, "engine", "collapse_tool_results_threshold", optionalNumber(value));
    case "streamToolExecution":
      return setTomlValue(toml, "engine", "stream_tool_execution", String(value));
    case "streamInterruptedMaxRetries":
      return setTomlValue(toml, "engine", "stream_interrupted_max_retries", optionalNumber(value));
    case "loopGuardMaxRepeats":
      return setTomlValue(toml, "engine", "loop_guard_max_repeats", optionalNumber(value));
    case "malformedToolArgsMaxRetries":
      return setTomlValue(toml, "engine", "malformed_tool_args_max_retries", optionalNumber(value));
    case "maxOutputTokenEscalationAttempts":
      return setTomlValue(toml, "engine", "max_output_token_escalation_attempts", optionalNumber(value));
    case "maxOutputTokenCeiling":
      return setTomlValue(toml, "engine", "max_output_token_ceiling", optionalNumber(value));
    case "systemPrompt":
      return setTomlValue(toml, "engine", "system_prompt", optionalString(value));
    case "compactAfterInputTokens":
      return setTomlValue(toml, "engine", "compact_after_input_tokens", optionalNumber(value));
    case "compactKeepRecent":
      return setTomlValue(toml, "engine", "compact_keep_recent", optionalNumber(value));
    case "protectFirstN":
      return setTomlValue(toml, "engine", "protect_first_n", optionalNumber(value));
    case "compactMaxRetries":
      return setTomlValue(toml, "engine", "compact_max_retries", optionalNumber(value));
    case "compactSummaryMaxTokens":
      return setTomlValue(toml, "engine", "compact_summary_max_tokens", optionalNumber(value));
    case "memoryExtractor":
      return setTomlValue(toml, "engine", "memory_extractor", String(value));
    case "memoryExtractorModel":
      return setTomlValue(toml, "engine", "memory_extractor_model", optionalString(value));
    case "memoryExtractorNoFilter":
      return setTomlValue(toml, "engine", "memory_extractor_no_filter", String(value));
    case "memoryWriteApproval":
      return setTomlValue(toml, "engine", "memory_write_approval", String(value));
    case "skillsGlobalDir":
      return setTomlValue(toml, "skills", "global_dir", optionalString(value));
    case "loggingFilter":
      return setTomlValue(toml, "logging", "filter", optionalString(value));
    case "loggingFile":
      return setTomlValue(toml, "logging", "file", optionalString(value));
    case "loggingMaxSizeMb":
      return setTomlValue(toml, "logging", "max_size_mb", optionalNumber(value));
    case "loggingMaxFiles":
      return setTomlValue(toml, "logging", "max_files", optionalNumber(value));
  }
}

function getString(toml: string, section: string, key: string): string | null {
  const raw = getScalar(toml, section, key);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function getBoolean(toml: string, section: string, key: string): boolean | null {
  const raw = getScalar(toml, section, key)?.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function getArrayStrings(toml: string, section: string, key: string): string[] {
  const raw = getScalar(toml, section, key)?.trim();
  if (!raw || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  const matches = raw.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
  return matches.map((item) => {
    try {
      return JSON.parse(item);
    } catch {
      return item.slice(1, -1);
    }
  });
}

function getScalar(toml: string, section: string, key: string): string | null {
  const lines = toml.split("\n");
  const range = findSection(lines, section);
  if (!range) return null;
  for (let i = range.start; i < range.end; i += 1) {
    const parsed = parseAssignment(lines[i]);
    if (parsed?.key === key) return parsed.value;
  }
  return null;
}

function setTomlValue(
  toml: string,
  section: string,
  key: string,
  value: string | null,
): string {
  const lines = toml.split("\n");
  const range = findSection(lines, section);
  if (!range) {
    if (value === null) return toml;
    const prefix = toml.trim().length > 0 && !toml.endsWith("\n") ? "\n\n" : "";
    return `${toml}${prefix}[${section}]\n${key} = ${value}\n`;
  }
  for (let i = range.start; i < range.end; i += 1) {
    const parsed = parseAssignment(lines[i]);
    if (parsed?.key === key) {
      if (value === null) {
        lines.splice(i, 1);
      } else {
        lines[i] = `${key} = ${value}`;
      }
      return lines.join("\n");
    }
  }
  if (value !== null) {
    lines.splice(range.end, 0, `${key} = ${value}`);
  }
  return lines.join("\n");
}

function findSection(lines: string[], section: string): { start: number; end: number } | null {
  const header = `[${section}]`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0) return null;
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[")) {
      end = i;
      break;
    }
  }
  return { start: headerIndex + 1, end };
}

function parseAssignment(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  return { key: match[1], value: stripComment(match[2]).trim() };
}

function stripComment(value: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (ch === "#" && !inString) return value.slice(0, i);
  }
  return value;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function optionalString(value: string | boolean): string | null {
  const text = String(value).trim();
  return text ? quote(text) : null;
}

function optionalNumber(value: string | boolean): string | null {
  const text = String(value).trim();
  return text ? text : null;
}

function stringArray(value: string): string {
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(quote);
  return `[${items.join(", ")}]`;
}

function pluginsFromToml(toml: string): PluginForm[] {
  return findArrayBlocks(toml.split("\n"), "plugins").map((block) => ({
    name: getStringFromBlock(block.lines, "name") ?? "",
    command: getStringFromBlock(block.lines, "command") ?? "",
    args: getArrayStringsFromBlock(block.lines, "args").join("\n"),
    cwd: getStringFromBlock(block.lines, "cwd") ?? "",
    env: envFromBlock(block.lines),
  }));
}

function mcpFromToml(toml: string): McpForm[] {
  return findArrayBlocks(toml.split("\n"), "mcp").map((block) => ({
    name: getStringFromBlock(block.lines, "name") ?? "",
    transport: getStringFromBlock(block.lines, "transport") ?? "stdio",
    command: getStringFromBlock(block.lines, "command") ?? "",
    args: getArrayStringsFromBlock(block.lines, "args").join("\n"),
    cwd: getStringFromBlock(block.lines, "cwd") ?? "",
    initTimeoutSecs: getScalarFromBlock(block.lines, "init_timeout_secs") ?? "",
    callTimeoutSecs: getScalarFromBlock(block.lines, "call_timeout_secs") ?? "",
    env: envFromBlock(block.lines),
  }));
}

function pluginToToml(plugin: PluginForm): string {
  const lines = [
    "[[plugins]]",
    `name = ${quote(plugin.name.trim())}`,
    `command = ${quote(plugin.command.trim())}`,
    `args = ${stringArray(plugin.args)}`,
  ];
  if (plugin.cwd.trim()) lines.push(`cwd = ${quote(plugin.cwd.trim())}`);
  appendEnv(lines, plugin.env, "plugins.env");
  return lines.join("\n");
}

function mcpToToml(server: McpForm): string {
  const lines = [
    "[[mcp]]",
    `name = ${quote(server.name.trim())}`,
    `transport = ${quote((server.transport || "stdio").trim())}`,
    `command = ${quote(server.command.trim())}`,
    `args = ${stringArray(server.args)}`,
  ];
  if (server.cwd.trim()) lines.push(`cwd = ${quote(server.cwd.trim())}`);
  if (server.initTimeoutSecs.trim()) {
    lines.push(`init_timeout_secs = ${server.initTimeoutSecs.trim()}`);
  }
  if (server.callTimeoutSecs.trim()) {
    lines.push(`call_timeout_secs = ${server.callTimeoutSecs.trim()}`);
  }
  appendEnv(lines, server.env, "mcp.env");
  return lines.join("\n");
}

function appendEnv(lines: string[], env: string, table: string) {
  const pairs = parseEnvLines(env);
  if (pairs.length === 0) return;
  lines.push("");
  lines.push(`[${table}]`);
  for (const [key, value] of pairs) {
    lines.push(`${key} = ${quote(value)}`);
  }
}

function parseEnvLines(env: string): Array<[string, string]> {
  return env
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line): [string, string] => {
      const idx = line.indexOf("=");
      if (idx < 0) return [line, ""];
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

function envFromBlock(lines: string[]): string {
  let inEnv = false;
  const pairs: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inEnv = trimmed === "[plugins.env]" || trimmed === "[mcp.env]";
      continue;
    }
    if (!inEnv) continue;
    const parsed = parseAssignment(line);
    if (parsed) {
      pairs.push(`${parsed.key}=${decodeTomlScalar(parsed.value)}`);
    }
  }
  return pairs.join("\n");
}

function replaceArrayBlocks(
  toml: string,
  name: "plugins" | "mcp",
  blocks: string[],
): string {
  const lines = toml.split("\n");
  const ranges = findArrayBlocks(lines, name);
  const section = blocks.join("\n\n");
  if (ranges.length === 0) {
    if (!section) return toml;
    const prefix = toml.trim().length > 0 && !toml.endsWith("\n") ? "\n\n" : "";
    return `${toml}${prefix}${section}\n`;
  }

  const start = ranges[0].start;
  const end = ranges[ranges.length - 1].end;
  const replacement = section ? section.split("\n") : [];
  lines.splice(start, end - start, ...replacement);
  return lines.join("\n");
}

function findArrayBlocks(lines: string[], name: "plugins" | "mcp") {
  const header = `[[${name}]]`;
  const blocks: Array<{ start: number; end: number; lines: string[] }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== header) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (
        trimmed.startsWith("[[") ||
        (trimmed.startsWith("[") && !trimmed.startsWith(`[${name}.`))
      ) {
        end = j;
        break;
      }
    }
    blocks.push({ start: i, end, lines: lines.slice(i, end) });
    i = end - 1;
  }
  return blocks;
}

function getStringFromBlock(lines: string[], key: string): string | null {
  const raw = getScalarFromBlock(lines, key);
  return raw ? decodeTomlScalar(raw) : null;
}

function getArrayStringsFromBlock(lines: string[], key: string): string[] {
  const raw = getScalarFromBlock(lines, key)?.trim();
  if (!raw || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  const matches = raw.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
  return matches.map(decodeTomlScalar);
}

function getScalarFromBlock(lines: string[], key: string): string | null {
  let nested = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      nested = !trimmed.startsWith("[[");
      continue;
    }
    if (nested) continue;
    const parsed = parseAssignment(line);
    if (parsed?.key === key) return parsed.value;
  }
  return null;
}

function decodeTomlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
