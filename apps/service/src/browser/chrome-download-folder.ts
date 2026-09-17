import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Chrome has no extension API for reading this preference. Only use an
 * unambiguous profile preference; never guess between profiles' destinations.
 * Paths stay in the native service, behind opaque folder selection IDs. */
export async function chromeDownloadFolder(options: {
  readonly userDataDirectory?: string;
  readonly defaultFolder?: string;
} = {}): Promise<string | undefined> {
  const home = homedir();
  const root = options.userDataDirectory ?? (process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
      : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'google-chrome'));
  const fallback = options.defaultFolder ?? join(home, 'Downloads');
  try {
    const localState = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'));
    const profiles = Object.keys(localState.profile?.info_cache ?? {});
    if (profiles.length === 0) return undefined;
    const folders = await Promise.all(profiles.map(async profile => {
      // Profile names are directory components, not paths supplied by a page.
      if (!/^(Default|Profile [0-9]+)$/u.test(profile)) return undefined;
      const preferences = JSON.parse(await readFile(join(root, profile, 'Preferences'), 'utf8'));
      const folder = preferences.download?.default_directory ?? fallback;
      return typeof folder === 'string' && isAbsolute(folder) ? folder : undefined;
    }));
    const folder = folders[0];
    return folder !== undefined && folders.every(candidate => candidate === folder) ? folder : undefined;
  } catch {
    return undefined;
  }
}
