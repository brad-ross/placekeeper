import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clipboard,
  FileText,
  Highlighter,
  ListChecks,
  LoaderCircle,
  Maximize2,
  Minus,
  MoveHorizontal,
  Pencil,
  PanelsTopLeft,
  Plus,
  Redo2,
  Replace,
  Save,
  StickyNote,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';

const reviewIcons = {
  alert: AlertCircle,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  clipboard: Clipboard,
  file: FileText,
  highlight: Highlighter,
  annotations: ListChecks,
  loading: LoaderCircle,
  minus: Minus,
  'fit-width': MoveHorizontal,
  main: Maximize2,
  edit: Pencil,
  references: PanelsTopLeft,
  plus: Plus,
  redo: Redo2,
  replace: Replace,
  save: Save,
  note: StickyNote,
  insert: TextCursorInput,
  delete: Trash2,
  warning: TriangleAlert,
  undo: Undo2,
  upload: Upload,
  close: X,
} satisfies Record<string, LucideIcon>;

export type ReviewIconName = keyof typeof reviewIcons;

export interface ReviewIconProps {
  readonly name: ReviewIconName;
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}

export function ReviewIcon({
  name,
  size = 16,
  strokeWidth = 1.875,
  className = 'review-icon',
}: ReviewIconProps) {
  const Icon = reviewIcons[name];
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      className={className}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
