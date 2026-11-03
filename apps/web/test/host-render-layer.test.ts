import { describe, expect, it, vi } from 'vitest';
import { createBrowserRasterOwner, subscribeBrowserRaster, subscribeNativeRaster } from '../src/pdf/HostRenderLayer.js';

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
  it('retains the state-owned image through key changes until a successor actually commits', () => {
    const owner = createBrowserRasterOwner();
    const hiddenRelease = vi.fn(), newerRelease = vi.fn();
    const hidden = owner.retain(hiddenRelease);
    owner.commit(hidden.order);
    const newer = owner.retain(newerRelease);
    owner.commit(hidden.order);
    expect(hiddenRelease).not.toHaveBeenCalled();
    expect(newerRelease).not.toHaveBeenCalled();
    owner.commit(newer.order);
    owner.dispose();
    expect(hiddenRelease).toHaveBeenCalledOnce();
    expect(newerRelease).toHaveBeenCalledOnce();
  });

  it('releases a browser bitmap when a data-image successor commits', () => {
    const owner = createBrowserRasterOwner();
    const release = vi.fn();
    const browser = owner.retain(release);
    owner.commit(browser.order);
    const native = owner.retain(() => {});
    owner.commit(native.order);
    expect(release).toHaveBeenCalledOnce();
    owner.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases replaced images after commit, preserves newer pending images and drains uncommitted images on unmount', () => {
    const owner = createBrowserRasterOwner();
    const revoked = vi.fn();
    const displayed = owner.retain(() => revoked('displayed'));
    owner.commit(displayed.order);
    const successor = owner.retain(() => revoked('successor'));
    const newer = owner.retain(() => revoked('newer'));
    expect(revoked).not.toHaveBeenCalled();
    owner.commit(successor.order);
    expect(revoked.mock.calls).toEqual([['displayed']]);
    // A repeated passive commit cannot retire the current image or a newer
    // publication that has not committed yet.
    owner.commit(successor.order);
    expect(revoked.mock.calls).toEqual([['displayed']]);
    owner.commit(newer.order);
    owner.retain(() => revoked('uncommitted'));
    owner.dispose();
    owner.dispose();
    displayed.release(); successor.release(); newer.release();
    expect(revoked.mock.calls).toEqual([['displayed'], ['successor'], ['newer'], ['uncommitted']]);
  });

  it('releases a published Blob URL once when its owner retires it and cancels the render', () => {
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

  it('keeps a displayed undecoded URL valid when its render is canceled and never allocates for a late render', () => {
    let rendered!: (blob: Blob) => void;
    const task = { wait: vi.fn(callback => { rendered = callback; }), abort: vi.fn() };
    const urls = { createObjectURL: vi.fn(() => 'blob:pending-raster'), revokeObjectURL: vi.fn() };
    const publish = vi.fn();
    const cleanup = subscribeBrowserRaster(task as unknown as Parameters<typeof subscribeBrowserRaster>[0], publish, urls);
    rendered(new Blob()); cleanup();
    // A refresh/scale change cancels the task while React still displays this
    // pending image. Only the image owner can release it after replacement.
    expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    const releaseImage = publish.mock.calls[0]![1] as () => void;
    releaseImage();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:pending-raster');
    rendered(new Blob());
    expect(urls.createObjectURL).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });
});
