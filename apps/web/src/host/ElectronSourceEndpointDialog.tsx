import { useId, useLayoutEffect, useRef, useState } from 'react';
import { trapDialogFocus } from '../app/dialog-focus.js';

export function ElectronSourceEndpointDialog(props: {
    readonly onConfirm: (endpoint: string) => void;
    readonly onCancel: () => void;
}) {
    const [endpoint, setEndpoint] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const titleId = useId(), descriptionId = useId();
    useLayoutEffect(() => {
        const previous = document.activeElement;
        input.current?.focus();
        return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
    }, []);
    return <div className="save-destination-backdrop">
        <form className="save-destination-dialog review-choice-dialog compact-editorial-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
            onSubmit={event => { event.preventDefault(); if (endpoint.trim()) props.onConfirm(endpoint); }}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
                else trapDialogFocus(event);
            }}>
            <header className="compact-editorial-modal__header"><h2 id={titleId}>Neovim endpoint</h2>
                <p id={descriptionId} className="compact-editorial-modal__description">Enter Neovim’s listening socket path or Windows named pipe.</p>
            </header>
            <div className="compact-editorial-modal__body">
                <label className="save-destination-filename"><span>Socket or named pipe</span>
                    <input ref={input} maxLength={4096} value={endpoint} onChange={event => setEndpoint(event.currentTarget.value)} />
                </label>
            </div>
            <footer className="compact-editorial-modal__footer">
                <button className="review-button" type="button" onClick={props.onCancel}>Cancel</button>
                <button className="review-button review-button--primary" type="submit" disabled={!endpoint.trim()}>Choose Source Folder…</button>
            </footer>
        </form>
    </div>;
}
