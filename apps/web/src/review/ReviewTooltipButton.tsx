import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

export const REVIEW_TOOLTIP_HOVER_DELAY_MS = 600;
const TOOLTIP_MARGIN = 8;

export interface ReviewTooltipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly tooltip?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function reviewTooltipFocusOpens(pointerActivation: boolean): boolean {
  return !pointerActivation;
}

export function reviewTooltipEscapeDismisses(key: string, isComposing: boolean): boolean {
  return key === 'Escape' && !isComposing;
}

/** A named icon button with a delayed pointer tooltip and immediate focus tooltip. */
export const ReviewTooltipButton = forwardRef<HTMLButtonElement, ReviewTooltipButtonProps>(
  function ReviewTooltipButton({
    label,
    tooltip = label,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    onClick,
    onKeyDown,
    onPointerDown,
    onPointerUp,
    onPointerCancel,
    'aria-describedby': describedBy,
    ...buttonProps
  }, forwardedRef) {
    const tooltipId = `review-tooltip-${useId().replaceAll(':', '')}`;
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const tooltipRef = useRef<HTMLSpanElement>(null);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pointerActivation = useRef(false);
    const [visible, setVisible] = useState(false);
    const [style, setStyle] = useState<CSSProperties>({});
    const clearHoverTimer = () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    };
    const hide = () => {
      clearHoverTimer();
      setVisible(false);
    };

    useLayoutEffect(() => {
      if (!visible) return;
      const button = buttonRef.current;
      const surface = tooltipRef.current;
      if (!button || !surface) return;
      const anchor = button.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      const viewportWidth = globalThis.visualViewport?.width ?? document.documentElement.clientWidth;
      const viewportHeight = globalThis.visualViewport?.height ?? document.documentElement.clientHeight;
      const viewportLeft = globalThis.visualViewport?.offsetLeft ?? 0;
      const viewportTop = globalThis.visualViewport?.offsetTop ?? 0;
      const centeredLeft = anchor.left + (anchor.width - bounds.width) / 2;
      const below = anchor.bottom + 7;
      const above = anchor.top - bounds.height - 7;
      setStyle({
        left: clamp(centeredLeft, viewportLeft + TOOLTIP_MARGIN, viewportLeft + viewportWidth - bounds.width - TOOLTIP_MARGIN),
        top: below + bounds.height <= viewportTop + viewportHeight - TOOLTIP_MARGIN ? below : Math.max(viewportTop + TOOLTIP_MARGIN, above),
      });
    }, [visible, tooltip]);

    useEffect(() => {
      if (!visible) return;
      const dismissForViewportChange = () => setVisible(false);
      window.addEventListener('resize', dismissForViewportChange);
      document.addEventListener('scroll', dismissForViewportChange, true);
      globalThis.visualViewport?.addEventListener('resize', dismissForViewportChange);
      globalThis.visualViewport?.addEventListener('scroll', dismissForViewportChange);
      return () => {
        window.removeEventListener('resize', dismissForViewportChange);
        document.removeEventListener('scroll', dismissForViewportChange, true);
        globalThis.visualViewport?.removeEventListener('resize', dismissForViewportChange);
        globalThis.visualViewport?.removeEventListener('scroll', dismissForViewportChange);
      };
    }, [visible]);

    useEffect(() => () => clearHoverTimer(), []);

    return <>
      <button
        {...buttonProps}
        ref={(element) => {
          buttonRef.current = element;
          if (typeof forwardedRef === 'function') forwardedRef(element);
          else if (forwardedRef) forwardedRef.current = element;
        }}
        aria-label={buttonProps['aria-label'] ?? label}
        title={buttonProps.disabled ? tooltip : undefined}
        aria-describedby={[describedBy, visible ? tooltipId : ''].filter(Boolean).join(' ') || undefined}
        onMouseEnter={(event: MouseEvent<HTMLButtonElement>) => {
          onMouseEnter?.(event);
          clearHoverTimer();
          hoverTimer.current = setTimeout(() => setVisible(true), REVIEW_TOOLTIP_HOVER_DELAY_MS);
        }}
        onMouseLeave={(event: MouseEvent<HTMLButtonElement>) => {
          onMouseLeave?.(event);
          hide();
        }}
        onFocus={(event: FocusEvent<HTMLButtonElement>) => {
          onFocus?.(event);
          clearHoverTimer();
          if (reviewTooltipFocusOpens(pointerActivation.current)) setVisible(true);
        }}
        onBlur={(event: FocusEvent<HTMLButtonElement>) => {
          onBlur?.(event);
          hide();
        }}
        onClick={(event) => {
          pointerActivation.current = false;
          hide();
          onClick?.(event);
        }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          pointerActivation.current = true;
          hide();
          onPointerDown?.(event);
        }}
        onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
          pointerActivation.current = false;
          onPointerUp?.(event);
        }}
        onPointerCancel={(event: PointerEvent<HTMLButtonElement>) => {
          pointerActivation.current = false;
          onPointerCancel?.(event);
        }}
        onKeyDown={(event) => {
          if (reviewTooltipEscapeDismisses(event.key, event.nativeEvent.isComposing)) hide();
          onKeyDown?.(event);
        }}
      />
      {visible && typeof document !== 'undefined' ? createPortal(
        <span ref={tooltipRef} id={tooltipId} className="review-tooltip" role="tooltip" style={style}>
          {tooltip}
        </span>,
        document.body,
      ) : null}
    </>;
  },
);
