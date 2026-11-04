import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ElectronSourceEndpointDialog } from '../src/host/ElectronSourceEndpointDialog.js';

it('collects only a named pipe or socket with the existing accessible modal form', () => {
    const html = renderToStaticMarkup(<ElectronSourceEndpointDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('save-destination-dialog review-choice-dialog compact-editorial-modal');
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby=');
    expect(html).toContain('Windows named pipe');
    expect(html).toContain('<span>Socket or named pipe</span>');
    expect(html).toContain('type="button">Cancel');
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toMatch(/executable|sourceRoot|type="file"/u);
});
