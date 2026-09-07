import {
  AlertCircle,
  ArrowLeft,
  ArrowRightLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Highlighter,
  FoldVertical,
  ListTree,
  Link,
  LocateFixed,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MoveHorizontal,
  PanelBottom,
  PanelRight,
  Pencil,
  PanelsTopLeft,
  Plus,
  Redo2,
  Save,
  Search,
  SquareArrowOutUpRight,
  StickyNote,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Undo2,
  UnfoldVertical,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';

const reviewIcons = {
  alert: AlertCircle,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  agent: Bot,
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  copy: Copy,
  file: FileText,
  download: Download,
  highlight: Highlighter,
  annotations: MessageSquare,
  outline: ListTree,
  link: Link,
  loading: LoaderCircle,
  locate: LocateFixed,
  minus: Minus,
  'more-horizontal': MoreHorizontal,
  'fit-width': MoveHorizontal,
  main: Maximize2,
  'open-main': SquareArrowOutUpRight,
  'panel-bottom': PanelBottom,
  'panel-right': PanelRight,
  'fold-vertical': FoldVertical,
  'unfold-vertical': UnfoldVertical,
  edit: Pencil,
  references: PanelsTopLeft,
  plus: Plus,
  redo: Redo2,
  replace: ArrowRightLeft,
  save: Save,
  search: Search,
  note: StickyNote,
  insert: TextCursorInput,
  delete: Trash2,
  remove: Trash2,
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
  strokeWidth = 2,
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
