/**
 * @file ActiveRecommendationSegment.tsx —— StatusBar 中的「主动文献推荐」微章 + 弹层。
 *
 * 形态(注意力心理学定调):底部状态栏常驻「✨ N」微章——余光可见、固定槽位、
 * 零占正文、不打断写作;想看时点开,上方弹出 top3 卡片,点别处自动收。把推荐
 * 从「文件树抽屉(拉取式,常关 → 送不达)」迁到「状态栏(环境感知,push 可达)」。
 *
 * 数据/插入全由 ActiveRecommendationService 驱动(subscribe/getState/insertCitation),
 * 本组件只做展示。indexState='disabled' → return null,不占位(对齐 ZoteroStatusBadge)。
 * 静默更新数字、无动画(守 active-jank 红线)。
 */

import { Loader2, Sparkles } from 'lucide-react';
import type React from 'react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { useClickOutside } from '../../hooks';
import { useTranslation } from '../../locales';
import {
  getActiveRecommendationService,
  type RecommendationState,
} from '../../services/zotero/ActiveRecommendationService';

export const ActiveRecommendationSegment: React.FC = () => {
  const { t } = useTranslation();
  const svc = getActiveRecommendationService();
  const state = useSyncExternalStore(
    (l) => svc.subscribe(l),
    () => svc.getState(),
    () => svc.getState()
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setOpen(false), open);

  // 功能未开启 → 整个微章隐藏,不占位。
  if (state.indexState === 'disabled') return null;

  const busy = state.indexState === 'building' || state.loading;
  const dim = state.indexState === 'no-key' || state.indexState === 'error';

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 h-full transition-colors cursor-pointer hover:bg-[var(--color-bg-hover)]"
        title={t('zoteroRecommend.title')}
        aria-label={t('zoteroRecommend.title')}
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
        ) : (
          <Sparkles size={11} style={{ color: dim ? 'var(--color-text-disabled)' : 'var(--color-accent)' }} />
        )}
        {state.items.length > 0 && (
          <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
            {state.items.length}
          </span>
        )}
      </button>

      {open && (
        <RecommendationPopover
          state={state}
          onInsert={(key) => {
            svc.insertCitation(key);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
};

interface PopoverProps {
  state: RecommendationState;
  onInsert: (citationKey: string) => void;
}

const RecommendationPopover: React.FC<PopoverProps> = ({ state, onInsert }) => {
  const { t } = useTranslation();
  return (
    <div
      className="absolute bottom-full right-0 mb-1 w-72 rounded-xl py-1 z-50 text-[11px]"
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <div
        className="px-3 py-1.5 font-semibold uppercase tracking-wider text-[11px]"
        style={{
          color: 'var(--color-text-muted)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        {t('zoteroRecommend.title')}
      </div>
      <RecommendationBody state={state} onInsert={onInsert} />
    </div>
  );
};

const RecommendationBody: React.FC<PopoverProps> = ({ state, onInsert }) => {
  const { t } = useTranslation();
  if (state.indexState === 'no-key') return <Hint text={t('zoteroRecommend.noKey')} />;
  if (state.indexState === 'building') return <Hint text={t('zoteroRecommend.building')} />;
  if (state.indexState === 'error') return <Hint text={t('zoteroRecommend.error')} />;
  if (state.loading && state.items.length === 0) return <Hint text={t('zoteroRecommend.loading')} />;
  if (state.items.length === 0) return <Hint text={t('zoteroRecommend.empty')} />;

  return (
    <ul role="list" className="max-h-72 overflow-y-auto py-1">
      {state.items.map((item) => (
        <li key={item.itemKey}>
          <button
            type="button"
            onClick={() => onInsert(item.citationKey ?? item.itemKey)}
            title={t('zoteroRecommend.insertHint')}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-bg-hover)]"
          >
            <div className="truncate text-[12px] text-[var(--color-text-primary)]" title={item.title}>
              {item.title}
            </div>
            {item.reason && (
              <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]">
                {item.reason}
              </div>
            )}
            <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              {item.citationKey ?? item.itemKey}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
};

const Hint: React.FC<{ text: string }> = ({ text }) => (
  <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">{text}</div>
);
