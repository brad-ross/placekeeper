import { useId, useState } from 'react';
import { Globe } from 'lucide-react';
const macIcon = new URL('../../../../packaging/macos/icon/Placekeeper.iconset/icon_128x128.png', import.meta.url).href;
const chatgptIcon = new URL('./assets/chatgpt.png', import.meta.url).href;
const chromeIcon = new URL('./assets/chrome.png', import.meta.url).href;
const vscodeIcon = new URL('./assets/vscode.png', import.meta.url).href;

const windowCaptures = {
  chatgpt: { src: new URL('./assets/surface-chatgpt.png', import.meta.url).href, width: 2880, height: 1800, alt: 'ChatGPT explaining the intuition behind Theorem 1 beside page 15 in the Placekeeper in-app document reader' },
  chrome: { src: new URL('./assets/surface-chrome.png', import.meta.url).href, width: 2880, height: 1800, alt: 'Chrome with the Placekeeper extension showing Section 4.1 and Appendix A in the bottom References tray, at the original arXiv URL' },
  vscode: { src: new URL('./assets/surface-vscode.png', import.meta.url).href, width: 2880, height: 1800, alt: 'VS Code showing the actual theory.tex source beside Section 4.1 in the Placekeeper PDF reader' },
  mac: { src: new URL('./assets/surface-mac.png', import.meta.url).href, width: 2400, height: 1504, alt: 'Placekeeper for Mac showing Section 4.1 with Search open and results for the LaTeX command \\Gamma' },
  browser: { src: new URL('./assets/surface-web.png', import.meta.url).href, width: 1152, height: 768, alt: 'Placekeeper’s web landing page in Chrome, with Upload PDF and document link controls' },
};
const surfaces = [
  { id: 'mac', label: 'Mac', icon: macIcon, description: 'Make Placekeeper your everyday document reader. Open local files with autosave and recovery.' },
  { id: 'chatgpt', label: 'ChatGPT', icon: chatgptIcon, description: 'Discuss the document and your comments in ChatGPT’s in-app browser.' },
  { id: 'chrome', label: 'Chrome Extension (experimental)', icon: chromeIcon, description: 'Open a document on the web and keep reading in its original tab, with Placekeeper’s tools at hand.' },
  { id: 'vscode', label: 'VS Code', icon: vscodeIcon, description: 'Review LaTeX output beside the source. Follow rebuilds and jump between the document and your editor.' },
  { id: 'browser', label: 'Web', icon: null, description: 'Open a local document or a public link without installing anything. Export a copy to keep your annotations.' },
] as const;

export function SurfaceShowcase() {
  const [selected, setSelected] = useState<(typeof surfaces)[number]>(surfaces[0]);
  const id = useId();
  const capture = windowCaptures[selected.id];
  return <section className="landing-surfaces" aria-label="Placekeeper app surfaces">
    <h2>Use Placekeeper where you work</h2>
    <div className="landing-surfaces__list">
      {surfaces.map((surface) => <button key={surface.id} type="button" aria-pressed={surface.id === selected.id}
        aria-controls={`${id}-illustration`} onClick={() => setSelected(surface)}>
        {surface.icon ? <img className="landing-surface-icon" src={surface.icon} alt="" width="28" height="28" /> : <Globe className="landing-surface-icon" aria-hidden="true" size={28} />}
        <span><strong>{surface.label}</strong><span>{surface.description}</span></span>
      </button>)}
    </div>
    <figure className={`landing-host landing-host--${selected.id}`} id={`${id}-illustration`} aria-label={`${selected.label} window screenshot`}>
      <img className="landing-host__capture" src={capture.src} alt={capture.alt} width={capture.width} height={capture.height} loading="lazy" />
    </figure>
  </section>;
}
