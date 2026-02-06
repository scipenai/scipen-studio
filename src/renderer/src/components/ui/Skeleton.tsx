/**
 * @file Skeleton.tsx - Skeleton component
 * @description Content loading placeholder component providing multiple preset layouts
 */

import { clsx } from 'clsx';
import type React from 'react';

export interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  animate?: boolean;
}

/**
 * Skeleton component - displays content loading placeholder
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  className,
  width,
  height,
  rounded = 'md',
  animate = true,
}) => {
  const roundedClasses = {
    none: 'rounded-none',
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    full: 'rounded-full',
  };

  return (
    <div
      className={clsx(
        'bg-gradient-to-r from-[var(--color-bg-tertiary)] via-[var(--color-bg-hover)] to-[var(--color-bg-tertiary)]',
        roundedClasses[rounded],
        animate && 'animate-shimmer bg-[length:200%_100%]',
        className
      )}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
      }}
    />
  );
};

/**
 * File tree skeleton - for file loading state
 */
export const FileTreeSkeleton: React.FC<{ rows?: number }> = ({ rows = 8 }) => {
  const widths = ['60%', '75%', '45%', '80%', '55%', '70%', '50%', '65%'];

  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={`file-skeleton-${i}`}
          className="flex items-center gap-2"
          style={{ paddingLeft: `${(i % 3) * 12}px` }}
        >
          <Skeleton width={14} height={14} rounded="sm" />
          <Skeleton height={14} width={widths[i % widths.length]} />
        </div>
      ))}
    </div>
  );
};

/**
 * Message skeleton - for chat message loading state
 */
export const MessageSkeleton: React.FC<{ role?: 'user' | 'assistant' }> = ({
  role = 'assistant',
}) => {
  const isUser = role === 'user';

  return (
    <div className={clsx('flex gap-3', isUser && 'flex-row-reverse')}>
      <Skeleton width={32} height={32} rounded="lg" />
      <div className={clsx('flex-1 space-y-2', isUser ? 'items-end' : 'items-start')}>
        <Skeleton height={16} width="80%" />
        <Skeleton height={16} width="60%" />
        {!isUser && <Skeleton height={16} width="70%" />}
      </div>
    </div>
  );
};

/**
 * List item skeleton - for list loading state
 */
export const ListItemSkeleton: React.FC<{ withIcon?: boolean; rows?: number }> = ({
  withIcon = true,
  rows = 5,
}) => {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`list-skeleton-${i}`} className="flex items-center gap-3 p-2">
          {withIcon && <Skeleton width={20} height={20} rounded="sm" />}
          <div className="flex-1 space-y-1.5">
            <Skeleton height={14} width={`${60 + (i % 3) * 15}%`} />
            <Skeleton height={10} width="40%" />
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Spinner component - displays loading state
 */
export const Spinner: React.FC<{
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}> = ({ size = 'md', className }) => {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-6 h-6 border-2',
    lg: 'w-8 h-8 border-3',
  };

  return (
    <div
      className={clsx(
        'animate-spin rounded-full border-solid border-t-transparent',
        sizeClasses[size],
        className
      )}
      style={{
        borderColor: 'var(--color-border)',
        borderTopColor: 'transparent',
      }}
    />
  );
};

export default Skeleton;
