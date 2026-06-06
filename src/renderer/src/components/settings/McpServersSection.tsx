/**
 * @file McpServersSection.tsx — MCP server CRUD for the Agent settings tab.
 *
 * Persists the array under `ConfigKeys.AgentMcpServers`. Each entry is
 * the wire shape (`McpServerConfig` from the editor protocol) so
 * `buildSnacaConfigFromSettings` can pass it straight through.
 *
 * Editing form is inline (expand row) rather than modal so users see
 * the list while tweaking one entry. New entries default to stdio
 * transport — the common case (npx/uvx-based servers).
 */

import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ConfigKeys } from '../../../../../shared/types/config-keys';
import { useTranslation } from '../../locales';
import {
  EmptyState,
  SectionTitle,
  SettingItem,
  inputClassName,
  inputMonoClassName,
} from './SettingsUI';

type Transport = 'stdio' | 'http';

interface McpServerEntry {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  init_timeout_secs?: number;
}

/** Server name validation mirrors `snaca_mcp::config::validate_server_name`
 *  (lowercase ascii / digits / `_-`, 1-64 chars). UI-side check is
 *  best-effort; backend is the source of truth and silently drops
 *  invalid rows. */
const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

const selectClassName =
  'h-9 px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] ' +
  'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] ' +
  'focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';

const buttonClass =
  'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border ' +
  'border-[var(--color-border)] bg-[var(--color-bg-secondary)] ' +
  'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]';

export const McpServersSection: React.FC = () => {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  useEffect(() => {
    void api.config.get<McpServerEntry[] | undefined>(ConfigKeys.AgentMcpServers).then((v) => {
      if (Array.isArray(v)) setServers(v);
    });
  }, []);

  const persist = useCallback((next: McpServerEntry[]) => {
    setServers(next);
    void api.config.set(ConfigKeys.AgentMcpServers, next, true);
  }, []);

  const onAdd = useCallback(() => {
    const baseName = 'server';
    let i = 1;
    while (servers.some((s) => s.name === `${baseName}${i}`)) i += 1;
    const next: McpServerEntry[] = [
      ...servers,
      { name: `${baseName}${i}`, transport: 'stdio', command: '', args: [], env: {} },
    ];
    persist(next);
    setExpandedIndex(next.length - 1);
  }, [servers, persist]);

  const onDelete = useCallback(
    (idx: number) => {
      if (
        !window.confirm(t('settingsAgent.mcp.deleteConfirm', { name: servers[idx]?.name ?? '' }))
      ) {
        return;
      }
      const next = servers.filter((_, i) => i !== idx);
      persist(next);
      // Adjust expandedIndex against the new array. Deleting at or
      // below the expanded row would otherwise leave the expansion
      // pointing at the wrong server (or out of bounds).
      if (expandedIndex !== null) {
        if (expandedIndex === idx) setExpandedIndex(null);
        else if (expandedIndex > idx) setExpandedIndex(expandedIndex - 1);
      }
    },
    [servers, persist, t, expandedIndex]
  );

  const updateAt = useCallback(
    (idx: number, patch: Partial<McpServerEntry>) => {
      const next = servers.map((s, i) => (i === idx ? { ...s, ...patch } : s));
      persist(next);
    },
    [servers, persist]
  );

  return (
    <>
      <SectionTitle>{t('settingsAgent.mcp.title')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('settingsAgent.mcp.desc')}
      </p>

      <div className="space-y-2 mb-3">
        {servers.length === 0 && <EmptyState>{t('settingsAgent.mcp.empty')}</EmptyState>}
        {servers.map((server, idx) => (
          <ServerRow
            key={idx}
            server={server}
            isExpanded={expandedIndex === idx}
            isDuplicateName={servers.findIndex((s) => s.name === server.name) !== idx}
            onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
            onChange={(patch) => updateAt(idx, patch)}
            onDelete={() => onDelete(idx)}
          />
        ))}
      </div>

      <button type="button" onClick={onAdd} className={buttonClass}>
        <Plus size={12} />
        {t('settingsAgent.mcp.add')}
      </button>

      <p className="text-[11px] text-amber-400/80 mt-3">{t('settingsAgent.mcp.restartHint')}</p>
    </>
  );
};

interface ServerRowProps {
  server: McpServerEntry;
  isExpanded: boolean;
  isDuplicateName: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<McpServerEntry>) => void;
  onDelete: () => void;
}

const ServerRow: React.FC<ServerRowProps> = ({
  server,
  isExpanded,
  isDuplicateName,
  onToggle,
  onChange,
  onDelete,
}) => {
  const { t } = useTranslation();
  const nameValid = NAME_PATTERN.test(server.name);
  const argsString = (server.args ?? []).join(' ');
  const envString = Object.entries(server.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-sm font-medium flex-1 truncate">
          {server.name || <em className="text-[var(--color-text-muted)]">(unnamed)</em>}
        </span>
        <span className="text-[10px] uppercase rounded px-1.5 py-0.5 bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
          {server.transport}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-red-400/80 hover:text-red-400 hover:bg-[var(--color-bg-tertiary)] rounded"
          title={t('settingsAgent.mcp.delete')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-3 space-y-3">
          <SettingItem label={t('settingsAgent.mcp.name')}>
            <input
              type="text"
              value={server.name}
              onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
              placeholder="my-server"
              className={inputMonoClassName}
            />
            {!nameValid && (
              <div className="mt-1 text-[11px] text-red-400">
                {t('settingsAgent.mcp.nameInvalid')}
              </div>
            )}
            {isDuplicateName && nameValid && (
              <div className="mt-1 text-[11px] text-amber-400">
                {t('settingsAgent.mcp.nameDuplicate')}
              </div>
            )}
          </SettingItem>

          <SettingItem label={t('settingsAgent.mcp.transport')}>
            <select
              value={server.transport}
              onChange={(e) => onChange({ transport: e.target.value as Transport })}
              className={selectClassName}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </SettingItem>

          {server.transport === 'stdio' && (
            <>
              <SettingItem
                label={t('settingsAgent.mcp.command')}
                description={t('settingsAgent.mcp.commandDesc')}
              >
                <input
                  type="text"
                  value={server.command ?? ''}
                  onChange={(e) => onChange({ command: e.target.value })}
                  placeholder="npx"
                  className={inputMonoClassName}
                />
              </SettingItem>

              <SettingItem
                label={t('settingsAgent.mcp.args')}
                description={t('settingsAgent.mcp.argsDesc')}
              >
                <input
                  type="text"
                  value={argsString}
                  onChange={(e) =>
                    onChange({
                      args: e.target.value
                        .split(/\s+/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    })
                  }
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  className={inputMonoClassName}
                />
              </SettingItem>

              <SettingItem
                label={t('settingsAgent.mcp.env')}
                description={t('settingsAgent.mcp.envDesc')}
              >
                <textarea
                  value={envString}
                  onChange={(e) => {
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split('\n')) {
                      const eq = line.indexOf('=');
                      if (eq <= 0) continue;
                      const k = line.slice(0, eq).trim();
                      const v = line.slice(eq + 1).trim();
                      if (k) env[k] = v;
                    }
                    onChange({ env });
                  }}
                  rows={3}
                  placeholder="KEY=value"
                  className={`${inputMonoClassName} h-auto py-2 text-xs`}
                />
              </SettingItem>
            </>
          )}

          {server.transport === 'http' && (
            <SettingItem
              label={t('settingsAgent.mcp.url')}
              description={t('settingsAgent.mcp.urlDesc')}
            >
              <input
                type="text"
                value={server.url ?? ''}
                onChange={(e) => onChange({ url: e.target.value })}
                placeholder="https://example.com/mcp"
                className={inputMonoClassName}
              />
            </SettingItem>
          )}

          <SettingItem
            label={t('settingsAgent.mcp.initTimeout')}
            description={t('settingsAgent.mcp.initTimeoutDesc')}
          >
            <input
              type="number"
              min={1}
              value={server.init_timeout_secs ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({
                  init_timeout_secs: Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined,
                });
              }}
              placeholder="30"
              className={inputClassName}
            />
          </SettingItem>
        </div>
      )}
    </div>
  );
};
