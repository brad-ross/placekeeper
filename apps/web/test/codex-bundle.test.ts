import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../vite.codex.config.js';

describe('packaged native reader', () => {
  it('embeds the genuine shared stylesheet after Vite emits CSS, with no external assets', async () => {
    const result = await build({ ...config, configFile: false, logLevel: 'silent', build: { ...config.build, write: false } });
    const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => 'output' in bundle ? bundle.output : []);
    const html = output.find(asset => asset.type === 'asset' && asset.fileName === 'review-v1.html');
    if (html?.type !== 'asset') throw new Error('Native HTML missing');
    const source = String(html.source);
    const css = source.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? '';
    expect(css).toContain('[data-production-review]');
    expect(css).toContain('.pdf-workspace__page');
    expect(css).toContain('.annotation-item');
    expect(css).toContain('--review-font-ui');
    expect(css).toContain('#root[data-production-root=true]{position:relative;inset:auto;min-height:0}');
    expect(css).toContain('#root[data-production-root=true] .review-shell{min-height:0}');
    expect(source).not.toMatch(/<link[^>]+stylesheet/u);
    expect(output.map(asset => asset.fileName)).toEqual(['review-v1.html']);
  }, 30_000);
});
