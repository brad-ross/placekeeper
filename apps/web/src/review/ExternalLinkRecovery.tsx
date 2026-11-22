import { useState } from 'react';
import { ReaderIcon } from './ReviewIcon.js';
import { ReaderTooltipButton } from './ReviewTooltipButton.js';

export function ExternalLinkRecovery({ url, onDismiss }: {
  readonly url: string;
  readonly onDismiss: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <aside className="external-link-recovery" data-review-contextual-ui aria-label="Web link recovery">
    <div className="external-link-recovery__heading">
      <p role="alert"><ReaderIcon name="alert" size={15} />Couldn’t open this link</p>
      <ReaderTooltipButton type="button" className="external-link-recovery__button" label="Dismiss link error" onClick={onDismiss}>
        <ReaderIcon name="close" size={14} />
      </ReaderTooltipButton>
    </div>
    <div className="external-link-recovery__destination">
      <span className="external-link-recovery__url" tabIndex={0} aria-label="Web link URL">{url}</span>
      <ReaderTooltipButton type="button" className="external-link-recovery__button" label="Copy URL"
        tooltip={copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Couldn’t copy link' : 'Copy URL'} onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopyStatus('copied');
          } catch { setCopyStatus('failed'); }
        }}>
        <ReaderIcon name={copyStatus === 'copied' ? 'check' : 'copy'} size={16} />
      </ReaderTooltipButton>
    </div>
    <span role="status" className="sr-only">
      {copyStatus === 'copied' ? 'URL copied.' : copyStatus === 'failed' ? 'Couldn’t copy link.' : ''}
    </span>
  </aside>;
}
