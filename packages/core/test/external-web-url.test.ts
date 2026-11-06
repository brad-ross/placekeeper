import { describe, expect, it } from 'vitest';
import { externalWebUrl } from '../src/external-web-url.js';

describe('external web URL eligibility', () => {
  it.each(['https://example.com/path?q=a%20b#part', 'http://example.com/'])('preserves %s', url => {
    expect(externalWebUrl(url)).toBe(url);
  });
  it('normalizes the destination shown and opened', () => {
    expect(externalWebUrl('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
  });
  it.each([null, {}, '', '/path', '//example.com', 'https:example.com', 'https:///example.com',
    'https://', 'https://exa mple.com', 'https://example.com\n.evil', 'https:\\example.com',
    ' javascript:alert(1)', 'javascript:alert(1)', 'file:///tmp/a', 'mailto:a@example.com',
    'placekeeper:///a', 'data:text/html,a'])('rejects %j', url => {
    expect(externalWebUrl(url)).toBeNull();
  });
});
