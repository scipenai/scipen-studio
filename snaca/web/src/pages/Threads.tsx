import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, RefreshCw } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";

export function Threads() {
  const { t } = useTranslation();
  const tenantsApi = useApi(useCallback(() => R.listTenants(), []));
  const [tenant, setTenant] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);

  useEffect(() => {
    if (!tenant && tenantsApi.data?.tenants.length) {
      setTenant(tenantsApi.data.tenants[0]);
    }
  }, [tenant, tenantsApi.data]);

  const projectsApi = useApi(
    useCallback(async () => {
      if (!tenant) return { projects: [] as string[] };
      return R.listProjects(tenant);
    }, [tenant]),
  );

  useEffect(() => {
    if (
      project &&
      projectsApi.data &&
      !projectsApi.data.projects.includes(project)
    ) {
      setProject(null);
      setThread(null);
    }
    if (!project && projectsApi.data?.projects.length) {
      setProject(projectsApi.data.projects[0]);
    }
  }, [project, projectsApi.data]);

  const threadsApi = useApi(
    useCallback(async () => {
      if (!tenant || !project) return { threads: [] as R.ThreadSummary[] };
      return R.listThreads(tenant, project);
    }, [tenant, project]),
  );

  useEffect(() => {
    if (
      thread &&
      threadsApi.data &&
      !threadsApi.data.threads.some((th) => th.id === thread)
    ) {
      setThread(null);
    }
    if (!thread && threadsApi.data?.threads.length) {
      setThread(threadsApi.data.threads[0].id);
    }
  }, [thread, threadsApi.data]);

  const messagesApi = useApi(
    useCallback(async () => {
      if (!thread) return { messages: [] as R.MessageDto[] };
      return R.listMessages(thread);
    }, [thread]),
  );

  const [abortBanner, setAbortBanner] = useState<string | null>(null);
  const onAbort = async () => {
    if (!thread) return;
    setAbortBanner(null);
    try {
      const resp = await R.abortThread(thread);
      setAbortBanner(
        resp.aborted
          ? t("threads.aborted_some", { count: resp.count })
          : t("threads.aborted_none"),
      );
    } catch (e) {
      setAbortBanner(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
          {t("threads.title")}
        </h1>
        <Button
          onClick={() => {
            void tenantsApi.refresh();
            void projectsApi.refresh();
            void threadsApi.refresh();
            void messagesApi.refresh();
          }}
          variant="ghost"
          size="sm"
        >
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[16rem_16rem_minmax(0,1fr)]">
        <Card title={t("threads.tenants")}>
          <List
            items={tenantsApi.data?.tenants ?? []}
            selected={tenant}
            onSelect={setTenant}
            loading={tenantsApi.loading}
          />
        </Card>
        <Card title={t("threads.projects")}>
          <List
            items={projectsApi.data?.projects ?? []}
            selected={project}
            onSelect={setProject}
            loading={projectsApi.loading}
          />
        </Card>
        <Card title={t("threads.threads")}>
          <List
            items={(threadsApi.data?.threads ?? []).map((t) => t.id)}
            selected={thread}
            onSelect={setThread}
            loading={threadsApi.loading}
            hints={Object.fromEntries(
              (threadsApi.data?.threads ?? []).map((th) => [
                th.id,
                th.created_at,
              ]),
            )}
          />
        </Card>
      </div>
      <Card
        title={t("threads.messages")}
        description={thread ?? t("threads.select_tenant")}
      >
        {thread && (
          <div className="mb-3 flex items-center gap-3">
            <Button variant="danger" size="sm" onClick={() => void onAbort()}>
              <CircleStop className="size-4" />
              {t("threads.abort")}
            </Button>
            {abortBanner && (
              <span className="text-xs text-ink-500 dark:text-ink-400">
                {abortBanner}
              </span>
            )}
          </div>
        )}
        {messagesApi.loading && (
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        )}
        {messagesApi.data?.messages.length === 0 && !messagesApi.loading && (
          <div className="text-sm text-ink-500">
            {t("threads.empty_messages")}
          </div>
        )}
        <ul className="space-y-3">
          {(messagesApi.data?.messages ?? []).map((m) => (
            <li
              key={m.id}
              className="rounded-md border border-ink-200/70 bg-ink-50 p-3 dark:border-ink-800 dark:bg-ink-950"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      m.role === "assistant"
                        ? "info"
                        : m.role === "tool"
                          ? "warning"
                          : m.role === "user"
                            ? "neutral"
                            : "success"
                    }
                  >
                    {m.role}
                  </Badge>
                  <span className="font-mono text-ink-500 dark:text-ink-400">
                    {m.created_at}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  {m.id}
                </span>
              </div>
              <div className="mt-2 space-y-2">
                {m.content.map((b, i) => (
                  <ContentBlockView key={i} block={b} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function List({
  items,
  selected,
  onSelect,
  loading,
  hints,
}: {
  items: string[];
  selected: string | null;
  onSelect: (v: string) => void;
  loading: boolean;
  hints?: Record<string, string>;
}) {
  if (loading && items.length === 0) {
    return <div className="text-sm text-ink-500">…</div>;
  }
  if (items.length === 0) {
    return <div className="text-sm text-ink-400">—</div>;
  }
  return (
    <ul className="max-h-96 overflow-y-auto">
      {items.map((it) => (
        <li key={it}>
          <button
            onClick={() => onSelect(it)}
            className={
              "block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-xs " +
              (selected === it
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
                : "text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800")
            }
            title={hints?.[it]}
          >
            {it}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ContentBlockView({ block }: { block: R.ContentBlock }) {
  if (block.type === "text" && typeof block.text === "string") {
    return (
      <pre className="whitespace-pre-wrap text-sm text-ink-800 dark:text-ink-100">
        {block.text}
      </pre>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div className="rounded bg-indigo-50 p-2 text-xs dark:bg-indigo-950/40">
        <div className="font-semibold text-indigo-700 dark:text-indigo-200">
          tool_use · {(block as { name?: string }).name}
        </div>
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-700 dark:text-ink-200">
          {JSON.stringify((block as { input?: unknown }).input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    const isError = (block as { is_error?: boolean }).is_error;
    return (
      <div
        className={
          isError
            ? "rounded bg-rose-50 p-2 text-xs dark:bg-rose-950/40"
            : "rounded bg-emerald-50 p-2 text-xs dark:bg-emerald-950/40"
        }
      >
        <div
          className={
            isError
              ? "font-semibold text-rose-700 dark:text-rose-200"
              : "font-semibold text-emerald-700 dark:text-emerald-200"
          }
        >
          tool_result {isError ? "(error)" : ""}
        </div>
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-700 dark:text-ink-200">
          {JSON.stringify((block as { content?: unknown }).content, null, 2)}
        </pre>
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap font-mono text-[11px] text-ink-600 dark:text-ink-300">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}
