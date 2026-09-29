import type { Ref } from 'react';

export function AnnotationNameField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly error?: string | undefined;
  readonly errorId: string;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  return <>
    <label className="save-destination-filename">
      <span>Name on annotations</span>
      <input ref={props.inputRef} value={props.value} disabled={props.disabled} title="Name on annotations"
        aria-invalid={props.error !== undefined}
        aria-describedby={props.error === undefined ? undefined : props.errorId}
        onChange={(event) => props.onChange(event.currentTarget.value)} />
    </label>
    {props.error === undefined ? null : <p id={props.errorId} className="save-destination-error" role="alert">{props.error}</p>}
  </>;
}
