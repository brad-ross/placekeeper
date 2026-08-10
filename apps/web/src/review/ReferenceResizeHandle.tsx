import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { ReferenceDock } from './reference-workspace-layout.js';

const RESIZE_STEP = 16;

interface ReferenceResizeInput {
  readonly dock: ReferenceDock;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export interface ReferenceResizeKeyInput extends ReferenceResizeInput {
  readonly key: string;
}

export interface ReferenceResizePointerInput extends Omit<ReferenceResizeInput, 'value'> {
  readonly startCoordinate: number;
  readonly currentCoordinate: number;
  readonly startValue: number;
}

export interface ReferenceResizeHandleProps extends ReferenceResizeInput {
  readonly controls: string;
  readonly onChange: (value: number) => void;
  readonly label?: string;
}

interface PointerResizeGesture {
  readonly pointerId: number;
  readonly startCoordinate: number;
  readonly startValue: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function referenceResizeKeyValue({
  dock,
  key,
  value,
  min,
  max,
}: ReferenceResizeKeyInput): number | null {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  const delta = dock === 'right'
    ? key === 'ArrowLeft' ? RESIZE_STEP : key === 'ArrowRight' ? -RESIZE_STEP : null
    : key === 'ArrowUp' ? RESIZE_STEP : key === 'ArrowDown' ? -RESIZE_STEP : null;
  return delta === null ? null : clamp(value + delta, min, max);
}

export function referenceResizePointerValue(input: ReferenceResizePointerInput): number {
  const delta = input.startCoordinate - input.currentCoordinate;
  return clamp(input.startValue + delta, input.min, input.max);
}

function remValue(value: number): string {
  const rem = value / RESIZE_STEP;
  return `${Number.isInteger(rem) ? rem : rem.toFixed(1)} rem`;
}

export function ReferenceResizeHandle({
  dock,
  controls,
  value,
  min,
  max,
  onChange,
  label = 'Resize References',
}: ReferenceResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<PointerResizeGesture | null>(null);
  const boundedValue = clamp(value, min, max);

  const releaseGesture = (element: HTMLDivElement, pointerId: number) => {
    if (gestureRef.current?.pointerId !== pointerId) return;
    gestureRef.current = null;
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  };

  useEffect(() => () => {
    const gesture = gestureRef.current;
    const element = handleRef.current;
    gestureRef.current = null;
    if (gesture && element?.hasPointerCapture?.(gesture.pointerId)) {
      element.releasePointerCapture(gesture.pointerId);
    }
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = referenceResizeKeyValue({ dock, key: event.key, value: boundedValue, min, max });
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const startCoordinate = dock === 'right' ? event.clientX : event.clientY;
    gestureRef.current = { pointerId: event.pointerId, startCoordinate, startValue: boundedValue };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    onChange(referenceResizePointerValue({
      dock,
      startCoordinate: gesture.startCoordinate,
      currentCoordinate: dock === 'right' ? event.clientX : event.clientY,
      startValue: gesture.startValue,
      min,
      max,
    }));
  };

  return (
    <div
      ref={handleRef}
      className="reference-resize-handle"
      data-reference-resize-handle={dock}
      role="separator"
      aria-label={label}
      aria-orientation={dock === 'right' ? 'vertical' : 'horizontal'}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={boundedValue}
      aria-valuetext={remValue(boundedValue)}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => releaseGesture(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => releaseGesture(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => {
        if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
      }}
    />
  );
}
