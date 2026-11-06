export function externalWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\/[^/\\\s]/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url.href : null;
  } catch { return null; }
}
