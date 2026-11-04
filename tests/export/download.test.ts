import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadText } from '../../src/export/download';

function stubDom() {
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: {} as Record<string, string>,
    click: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { appendChild } });
  const createObjectURL = vi.fn((_b: Blob) => 'blob:fake/1');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', Object.assign(function () {}, { createObjectURL, revokeObjectURL }));
  return { anchor, appendChild, createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('downloadBlob', () => {
  it('clicks a temporary <a download> and revokes the object URL afterwards', () => {
    vi.useFakeTimers();
    const dom = stubDom();
    const blob = new Blob(['x']);
    downloadBlob(blob, 'barleycorn-4172.svg');
    expect(dom.createObjectURL).toHaveBeenCalledWith(blob);
    expect(dom.anchor.href).toBe('blob:fake/1');
    expect(dom.anchor.download).toBe('barleycorn-4172.svg');
    expect(dom.appendChild).toHaveBeenCalledWith(dom.anchor);
    expect(dom.anchor.click).toHaveBeenCalledTimes(1);
    expect(dom.anchor.remove).toHaveBeenCalledTimes(1);
    expect(dom.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(dom.revokeObjectURL).toHaveBeenCalledWith('blob:fake/1');
  });
});

describe('downloadText', () => {
  it('wraps text in a Blob with the mime type (utf-8 for text types)', async () => {
    vi.useFakeTimers();
    const dom = stubDom();
    downloadText('G21\n', 'a.gcode', 'text/plain');
    const blob = dom.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(await blob.text()).toBe('G21\n');
    downloadText('<svg/>', 'a.svg', 'image/svg+xml');
    expect(dom.createObjectURL.mock.calls[1][0].type).toBe('image/svg+xml;charset=utf-8');
    downloadText('{}', 'a.bin', 'application/octet-stream');
    expect(dom.createObjectURL.mock.calls[2][0].type).toBe('application/octet-stream');
  });
});
