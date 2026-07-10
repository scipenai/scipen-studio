import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { PauseCircle, PlayCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { EmptyRow, Table, Td, Th, Tr } from "../components/ui/Table";

export function Schedules() {
  const { t } = useTranslation();
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState(() => defaultForm());
  const fetcher = useCallback(
    () => R.listSchedules(enabledOnly),
    [enabledOnly],
  );
  const { data, error, loading, refresh } = useApi(fetcher);

  const onToggle = async (id: string, enabled: boolean) => {
    await R.setScheduleEnabled(id, enabled);
    await refresh();
  };
  const onDelete = async (id: string) => {
    if (!window.confirm(t("common.confirm_delete"))) return;
    await R.deleteSchedule(id);
    await refresh();
  };
  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await R.createSchedule({
        tenant_id: form.tenant_id.trim(),
        project_id: form.project_id.trim(),
        chat_id: form.chat_id.trim(),
        plugin: form.plugin.trim(),
        prompt: form.prompt.trim(),
        interval_secs: form.interval_secs.trim()
          ? Number(form.interval_secs.trim())
          : null,
        next_fire_at: localDateTimeToRfc3339(form.next_fire_at),
      });
      setForm(defaultForm());
      await refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
            {t("schedules.title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            {t("schedules.subtitle")}
          </p>
        </div>
        <Button onClick={() => void refresh()} variant="ghost" size="sm">
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </header>
      <Card>
        <form
          className="mb-5 grid gap-3 border-b border-ink-200 pb-5 dark:border-ink-800 md:grid-cols-2 xl:grid-cols-4"
          onSubmit={(e) => void onCreate(e)}
        >
          <TextField label={t("schedules.tenant")} value={form.tenant_id} onChange={(v) => setForm((f) => ({ ...f, tenant_id: v }))} />
          <TextField label={t("schedules.project")} value={form.project_id} onChange={(v) => setForm((f) => ({ ...f, project_id: v }))} />
          <TextField label={t("schedules.plugin")} value={form.plugin} onChange={(v) => setForm((f) => ({ ...f, plugin: v }))} />
          <TextField label={t("schedules.chat")} value={form.chat_id} onChange={(v) => setForm((f) => ({ ...f, chat_id: v }))} />
          <label className="text-xs font-medium text-ink-600 dark:text-ink-300 xl:col-span-2">
            {t("schedules.prompt")}
            <textarea
              className={fieldClass}
              rows={3}
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </label>
          <TextField
            label={t("schedules.next_fire")}
            type="datetime-local"
            value={form.next_fire_at}
            onChange={(v) => setForm((f) => ({ ...f, next_fire_at: v }))}
          />
          <TextField
            label={t("schedules.interval")}
            value={form.interval_secs}
            inputMode="numeric"
            placeholder={t("schedules.one_shot")}
            onChange={(v) => setForm((f) => ({ ...f, interval_secs: v }))}
          />
          <div className="flex items-end xl:col-span-4">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={creating}
            >
              <Plus className="size-4" />
              {creating ? t("schedules.creating") : t("schedules.create")}
            </Button>
          </div>
          {createError && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200 md:col-span-2 xl:col-span-4">
              {createError}
            </div>
          )}
        </form>
        <label className="mb-3 flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={(e) => setEnabledOnly(e.target.checked)}
          />
          {t("schedules.enabled_only")}
        </label>
        {error && (
          <div className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
            {error}
          </div>
        )}
        {loading && !data ? (
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("schedules.plugin")}</Th>
                <Th>{t("schedules.chat")}</Th>
                <Th>{t("schedules.prompt")}</Th>
                <Th>{t("schedules.interval")}</Th>
                <Th>{t("schedules.next_fire")}</Th>
                <Th>{t("schedules.last_fired")}</Th>
                <Th>{t("schedules.enabled")}</Th>
                <Th>{t("schedules.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.schedules ?? []).length === 0 ? (
                <EmptyRow colSpan={8} message={t("schedules.empty")} />
              ) : (
                data!.schedules.map((s) => (
                  <Tr key={s.id}>
                    <Td className="font-mono text-xs">{s.plugin}</Td>
                    <Td className="font-mono text-xs">{s.chat_id}</Td>
                    <Td className="max-w-[24rem] truncate text-xs" title={s.prompt}>
                      {s.prompt}
                    </Td>
                    <Td className="font-mono text-xs">
                      {s.interval_secs ?? "one-shot"}
                    </Td>
                    <Td className="font-mono text-xs">{s.next_fire_at}</Td>
                    <Td className="font-mono text-xs">{s.last_fired_at ?? "—"}</Td>
                    <Td>
                      <Badge tone={s.enabled ? "success" : "neutral"}>
                        {s.enabled ? "on" : "off"}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void onToggle(s.id, !s.enabled)}
                        >
                          {s.enabled ? (
                            <>
                              <PauseCircle className="size-4" />
                              {t("schedules.pause")}
                            </>
                          ) : (
                            <>
                              <PlayCircle className="size-4" />
                              {t("schedules.resume")}
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void onDelete(s.id)}
                        >
                          <Trash2 className="size-4" />
                          {t("schedules.delete")}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

type CreateScheduleForm = {
  tenant_id: string;
  project_id: string;
  chat_id: string;
  plugin: string;
  prompt: string;
  next_fire_at: string;
  interval_secs: string;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-ink-700 dark:bg-ink-950 dark:text-ink-50";

function defaultForm(): CreateScheduleForm {
  const d = new Date(Date.now() + 60_000);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  return {
    tenant_id: "default",
    project_id: "default",
    chat_id: "",
    plugin: "lark",
    prompt: "",
    next_fire_at: local,
    interval_secs: "",
  };
}

function localDateTimeToRfc3339(value: string): string {
  return new Date(value).toISOString();
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "numeric";
  placeholder?: string;
}) {
  return (
    <label className="text-xs font-medium text-ink-600 dark:text-ink-300">
      {label}
      <input
        className={fieldClass}
        type={type}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
