"""Rebuild the demo asset from arXiv:2312.07520v3 (requires pypdf 6.10).

Usage: python scripts/build-demo-excerpt.py /path/to/2312.07520v3.pdf
Only direct references from pages 14–16 are followed; references within the
retained sections do not recursively expand the excerpt to the whole paper.
"""
import json
from pathlib import Path
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject

ASSETS = Path(__file__).resolve().parents[1] / 'apps/web/src/landing/assets'
# Sections 2.1–2.2, 3–4, bibliography and A, D, and F.1–F.3.
# Shared boundary pages retain the end of each referenced section.
RANGES = [(6, 9), (12, 19), (25, 33), (46, 52), (75, 79)]
pages = [n for first, last in RANGES for n in range(first, last + 1)]
source = PdfReader(sys.argv[1])
assert len(source.pages) == 100, 'Expected the 100-page v3 paper'
annotations = {n: source.pages[n - 1].pop(NameObject('/Annots'), []) for n in pages}
writer = PdfWriter()
writer.append(source, pages=[n - 1 for n in pages], import_outline=True, excluded_fields=['/Annots'])
source_page_numbers = {page.indirect_reference.idnum: n for n, page in enumerate(source.pages, 1)}
retained = {n: i for i, n in enumerate(pages)}

for output_index, original_number in enumerate(pages):
    for ref in annotations[original_number]:
        annotation = ref.get_object()
        action = annotation.get('/A', {})
        destination = annotation.get('/Dest') or action.get('/D')
        mapped = None
        if destination is not None:
            if isinstance(destination, str):
                destination = source.named_destinations[destination].dest_array
            else:
                destination = destination.get_object()
            target = source_page_numbers.get(destination[0].idnum)
            if target not in retained:
                assert original_number not in (14, 15, 16), f'Missing direct target: {target}'
                continue
            mapped = ArrayObject([writer.pages[retained[target]].indirect_reference,
                                  *[value.clone(writer) for value in destination[1:]]])
        # Do not clone page pointers or old navigation actions into the new file.
        copied = DictionaryObject({key: value.clone(writer) for key, value in annotation.items()
                                   if key not in ('/P', '/Dest', '/A')})
        if mapped is None and action:
            copied[NameObject('/A')] = action.clone(writer)
        added = writer.add_annotation(output_index, copied)
        if mapped is not None:
            added[NameObject('/Dest')] = mapped

writer.add_metadata({'/Title': 'Estimating Counterfactual Matrix Means with Short Panel Data (demo excerpt)',
                     '/Author': 'Lihua Lei and Brad Ross'})
output = ASSETS / 'counterfactual-matrix-means.pdf'
writer.write(output)
(ASSETS / 'demo-page-map.json').write_text(json.dumps({
    'originalPageCount': len(source.pages), 'originalPages': pages,
}, indent=2) + '\n')
print(f'Wrote {len(pages)} pages, {output.stat().st_size:,} bytes')
