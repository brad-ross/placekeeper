import { useState } from 'react';

export function ExternalLinkRecovery({ url, onDismiss }: {
  readonly url: string;
  readonly onDismiss: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  return <aside className="external-link-recovery" data-review-contextual-ui aria-label="Web link recovery">
    <p role="alert">Couldn’t open this web link.</p>
    <input aria-label="Web link URL" readOnly value={url} onFocus={event => event.currentTarget.select()} />
    <div>
      <button type="button" onClick={async () => {
        try {
          if (navigator.clipboard === undefined) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(url);
          setCopyStatus('URL copied.');
        } catch { setCopyStatus('Select the URL above and copy it.'); }
      }}>Copy URL</button>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </aside>;
}
