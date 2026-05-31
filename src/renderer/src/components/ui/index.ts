/**
 * @file index.ts - UI component library exports
 * @description Unified component export entry for SciPen Studio Quantum Ink design system
 */

export { Button, type ButtonProps } from './Button';
export { Input, Textarea, type InputProps, type TextareaProps } from './Input';
export { Select, type SelectProps, type SelectOption } from './Select';
export { Toggle, Checkbox, type ToggleProps, type CheckboxProps } from './Toggle';
export { IconButton, type IconButtonProps } from './IconButton';
export { CopyButton, type CopyButtonProps } from './CopyButton';

export {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
  type CardProps,
  type CardHeaderProps,
  type CardContentProps,
  type CardFooterProps,
} from './Card';
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps,
} from './Tabs';

export { Badge, type BadgeProps } from './Badge';
export { Modal, type ModalProps } from './Modal';

export {
  Skeleton,
  FileTreeSkeleton,
  MessageSkeleton,
  ListItemSkeleton,
  Spinner,
  type SkeletonProps,
} from './Skeleton';

export type { SkeletonProps as BaseSkeletonProps } from './Skeleton';
