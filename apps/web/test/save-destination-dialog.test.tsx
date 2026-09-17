import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ExportAnnotationDialog } from '../src/save/ExportAnnotationDialog.js';
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

    expect(html).toContain('Name on annotations');
    expect(html.indexOf('</fieldset>')).toBeLessThan(html.indexOf('Name on annotations'));
    expect(html).not.toContain('Remembered for future documents');
    expect(html).not.toContain('Change location…');
    expect(html.match(/<span title="\/Documents\/Reviews">\/Documents\/Reviews<\/span>/g)).toHaveLength(1);
    expect(html.indexOf('/Documents/Reviews')).toBeLessThan(html.indexOf('aria-label="Copy name"'));
    expect(html).toContain('aria-label="Change save location. Current location: /Documents/Reviews"');
    expect(html).toContain('title="Enter a name for the PDF copy"');
  });
});

it('associates a rejected name with the existing modal error treatment', () => {
  const html = renderToStaticMarkup(<SaveDestinationDialog open annotationName="Brad Ross"
    nameError="Choose a shorter name." onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(html).toContain('value="Brad Ross"');
  expect(html).toMatch(/aria-invalid="true" aria-describedby="[^"]+"/u);
  expect(html).toMatch(/<p id="[^"]+" class="save-destination-error" role="alert">Choose a shorter name./u);
});

it('uses the same field and modal classes for export without global preference text', () => {
  const html = renderToStaticMarkup(<ExportAnnotationDialog annotationName="Brad Ross"
    pending={false} error="Choose a shorter name." onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(html).toContain('save-destination-dialog review-choice-dialog compact-editorial-modal');
  expect(html).toContain('class="save-destination-filename"');
  expect(html).toContain('Name on annotations');
  expect(html).toContain('value="Brad Ross"');
  expect(html).toMatch(/aria-invalid="true" aria-describedby="[^"]+"/u);
  expect(html).not.toContain('Remembered for future documents');
});

it('enables Save immediately with the browser PDF name and downloads proposal', () => {
  const html = renderToStaticMarkup(<SaveDestinationDialog open sourceDisposition="remote-temporary"
    proposal={{ sourceDisposition: 'remote-temporary', filename: 'Original paper.pdf',
      folder: 'Chrome downloads folder', folderSelectionId: 'download-selection' }}
    onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(html).toContain('value="Original paper.pdf"');
  expect(html).toMatch(/<button[^>]*title="Save annotations"(?![^>]*disabled)[^>]*><span>Save<\/span>/u);
  expect(html).not.toContain('>Confirm<');
});
