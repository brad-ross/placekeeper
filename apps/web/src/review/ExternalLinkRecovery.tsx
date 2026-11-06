import { useState } from 'react';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export function ExternalLinkRecovery({ url, onDismiss }: {
  readonly url: string;
  readonly onDismiss: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <aside className="external-link-recovery" data-review-contextual-ui aria-label="Web link recovery">
    <div className="external-link-recovery__heading">
      <p role="alert">Couldn’t open this link</p>
      <ReviewTooltipButton type="button" className="external-link-recovery__button" label="Dismiss link error" onClick={onDismiss}>
        <ReviewIcon name="close" size={14} />
      </ReviewTooltipButton>
    </div>
    <div className="external-link-recovery__destination">
      <span className="external-link-recovery__url" tabIndex={0} aria-label="Web link URL">{url}</span>
      <ReviewTooltipButton type="button" className="external-link-recovery__button" label="Copy URL"
        tooltip={copyStatus === 'copied' ? 'Copied' : 'Copy URL'} onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopyStatus('copied');
          } catch { setCopyStatus('failed'); }
        }}>
        <ReviewIcon name={copyStatus === 'copied' ? 'check' : 'copy'} size={16} />
      </ReviewTooltipButton>
    </div>
    <span role="status" className={copyStatus === 'failed' ? 'external-link-recovery__hint' : 'sr-only'}>
      {copyStatus === 'copied' ? 'URL copied.' : copyStatus === 'failed' ? 'Select the link to copy it manually.' : ''}
    </span>
  </aside>;
}
