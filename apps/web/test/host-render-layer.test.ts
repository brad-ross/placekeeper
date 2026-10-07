import { describe, expect, it, vi } from 'vitest';
import { subscribeBrowserRaster, subscribeNativeRaster } from '../src/pdf/HostRenderLayer.js';

describe('native raster image source', () => {
  it('publishes a data image only while its render is current and cancels pending conversion', () => {
    let rendered!: (blob: Blob) => void;
    const task = { wait: vi.fn(callback => { rendered = callback; }), abort: vi.fn() };
    const reader = { readyState: 1, result: 'data:image/png;base64,cGl4ZWxz', onload: null as null | (() => void), readAsDataURL: vi.fn(), abort: vi.fn() };
    const publish = vi.fn();
    const release = subscribeNativeRaster(task as unknown as Parameters<typeof subscribeNativeRaster>[0], publish, () => reader as unknown as FileReader);
    const blob = new Blob(['pixels'], { type: 'image/png' });
    rendered(blob);
    expect(reader.readAsDataURL).toHaveBeenCalledWith(blob);
    const lateLoad = reader.onload!;
    reader.onload!();
    expect(publish).toHaveBeenCalledExactlyOnceWith(reader.result);
    release();
    lateLoad();
    rendered(blob);
    expect(publish).toHaveBeenCalledOnce();
    expect(reader.readAsDataURL).toHaveBeenCalledOnce();
    expect(reader.abort).toHaveBeenCalledOnce();
    expect(task.abort).toHaveBeenCalledOnce();
  });

  it('does not start an image conversion after the render has been superseded or unmounted', () => {
    let rendered!: (blob: Blob) => void;
    const task = { wait: vi.fn(callback => { rendered = callback; }), abort: vi.fn() };
    const createReader = vi.fn();
    const publish = vi.fn();
    subscribeNativeRaster(task as unknown as Parameters<typeof subscribeNativeRaster>[0], publish, createReader)();
    rendered(new Blob());
    expect(createReader).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('browser raster image source', () => {
  it('releases a decoded Blob URL once and cancels the retired render', () => {
    let rendered!: (blob: Blob) => void;
    const task = { wait: vi.fn(callback => { rendered = callback; }), abort: vi.fn() };
    const urls = { createObjectURL: vi.fn(() => 'blob:page-raster'), revokeObjectURL: vi.fn() };
    const publish = vi.fn();
    const cleanup = subscribeBrowserRaster(task as unknown as Parameters<typeof subscribeBrowserRaster>[0], publish, urls);
    const blob = new Blob(['pixels']); rendered(blob);
    expect(urls.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
    expect(publish.mock.calls[0]![0]).toBe('blob:page-raster');
    const release = publish.mock.calls[0]![1] as () => void;
    release(); cleanup();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:page-raster');
    expect(task.abort).toHaveBeenCalledOnce();
    rendered(blob);
    expect(urls.createObjectURL).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('releases an undecoded URL on replacement and never allocates for a late render', () => {
    let rendered!: (blob: Blob) => void;
    const task = { wait: vi.fn(callback => { rendered = callback; }), abort: vi.fn() };
    const urls = { createObjectURL: vi.fn(() => 'blob:pending-raster'), revokeObjectURL: vi.fn() };
    const publish = vi.fn();
    const cleanup = subscribeBrowserRaster(task as unknown as Parameters<typeof subscribeBrowserRaster>[0], publish, urls);
    rendered(new Blob()); cleanup();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:pending-raster');
    rendered(new Blob());
    expect(urls.createObjectURL).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });
});
