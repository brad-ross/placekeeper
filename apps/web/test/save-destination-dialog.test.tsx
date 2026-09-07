import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SaveDestinationDialog } from '../src/save/SaveDestinationDialog.js';

describe('save destination dialog layout', () => {
  it('offers one location action with its path before the accessible filename field', () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ sourceDisposition: 'local', filename: 'paper-reviewed.pdf', folder: '/Documents/Reviews' }}
      onChooseLocation={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).not.toContain('Change location…');
    expect(html.match(/<span title="\/Documents\/Reviews">\/Documents\/Reviews<\/span>/g)).toHaveLength(1);
    expect(html.indexOf('/Documents/Reviews')).toBeLessThan(html.indexOf('aria-label="Copy name"'));
    expect(html).toContain('aria-label="Change save location. Current location: /Documents/Reviews"');
    expect(html).toContain('title="Enter a name for the PDF copy"');
  });
});
