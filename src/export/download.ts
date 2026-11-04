// Browser downloads via an object URL and a temporary <a download>.

/** Delay before revoking the object URL: revoking right after click() can cancel the download in some browsers. */
const REVOKE_DELAY_MS = 10_000;

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

export function downloadText(text: string, filename: string, mime: string): void {
  const type = /^text\/|\+xml$|\/json$|\/xml$/.test(mime) && !/charset=/i.test(mime) ? `${mime};charset=utf-8` : mime;
  downloadBlob(new Blob([text], { type }), filename);
}
