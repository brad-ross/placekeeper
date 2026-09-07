"""Rebuild index.html using the installed Visualize standalone renderer.

Usage: python3 build-reference.py /absolute/path/to/visualize/skills/visualize
The source fragment and generated index are both checked in for review.
"""
from pathlib import Path
import subprocess
import sys
import tempfile

base = Path(__file__).resolve().parent
skill = Path(sys.argv[1]).resolve()
source = (base / 'canonical.html').read_text()
controls = (base / 'review-controls.html').read_text()
hook = """
<script>
(() => {
  const root = document.getElementById('pk-canonical');
  const scene = document.getElementById('pk-review-scene');
  const width = document.getElementById('pk-review-width');
  const surface = document.getElementById('pk-review-surface');
  scene.addEventListener('change', () => root.setScene(scene.value));
  width.addEventListener('change', () => { surface.style.width = width.value + 'px'; root.setScene(root.getScene()); });
})();
</script>
"""
with tempfile.TemporaryDirectory(prefix='placekeeper-design-reference-') as directory:
    fragment = Path(directory) / 'review.html'
    fragment.write_text(controls + '<div id="pk-review-surface" style="width:1024px;max-width:100%;margin:auto">' + source + '</div>' + hook)
    subprocess.run([sys.executable, str(skill / 'scripts/render.py'), str(fragment), str(base / 'index.html'), '--force'], check=True)
