/**
 * ThemeScript - Initializes theme from localStorage before React hydration
 * This prevents the flash of wrong theme on page load.
 *
 * Must be a Server Component: in Next.js / React 19, <script> tags rendered
 * by Client Components are inert on the client. Rendering it from the server
 * inlines the snippet into the SSR HTML so the browser executes it before
 * hydration.
 */
export default function ThemeScript() {
  const themeScript = `
    (function() {
      try {
        // One-way migration from the predecessor's browser namespace. Building
        // the legacy prefix at runtime keeps it out of Knorvia's public brand.
        const legacyPrefix = ['deep', 'tutor'].join('');
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.toLowerCase().startsWith(legacyPrefix)) keys.push(key);
        }
        for (const key of keys) {
          const nextKey = 'knorvia' + key.slice(legacyPrefix.length);
          if (localStorage.getItem(nextKey) === null) {
            localStorage.setItem(nextKey, localStorage.getItem(key) || '');
          }
          localStorage.removeItem(key);
        }
        const stored = localStorage.getItem('knorvia-theme');

        document.documentElement.classList.remove('dark', 'theme-glass', 'theme-snow');

        if (stored === 'dark') {
          document.documentElement.classList.add('dark');
        } else if (stored === 'glass') {
          document.documentElement.classList.add('theme-glass');
        } else if (stored === 'snow') {
          document.documentElement.classList.add('theme-snow');
        } else if (stored === 'light') {
          // already clean
        } else {
          // No stored preference: Default (snow) for light systems,
          // Dark for prefers-color-scheme: dark.
          if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('knorvia-theme', 'dark');
          } else {
            document.documentElement.classList.add('theme-snow');
            localStorage.setItem('knorvia-theme', 'snow');
          }
        }

        var frostRaw = localStorage.getItem('knorvia-window-frost');
        var frostOn = frostRaw === 'true' || (frostRaw === null && stored === 'glass');
        var clarity = parseInt(localStorage.getItem('knorvia-frost-clarity') || '62', 10);
        var plates = parseInt(localStorage.getItem('knorvia-frost-plates') || '86', 10);
        if (!(clarity >= 0 && clarity <= 100)) clarity = 62;
        if (!(plates >= 0 && plates <= 100)) plates = 86;
        var htmlEl = document.documentElement;
        if (frostOn) {
          htmlEl.setAttribute('data-window-frost', '');
          var canvas = Math.round(82 - (70 * clarity) / 100);
          var sidebar = Math.max(8, Math.round(canvas * 0.62));
          var plate = Math.round(62 + (34 * plates) / 100);
          htmlEl.style.setProperty('--frost-canvas', canvas + '%');
          htmlEl.style.setProperty('--frost-sidebar', sidebar + '%');
          htmlEl.style.setProperty('--frost-plate', plate + '%');
          htmlEl.style.setProperty('--frost-popover', Math.min(98, plate + 6) + '%');
          htmlEl.style.setProperty('--frost-muted', Math.round((canvas + plate) / 2) + '%');
        } else {
          htmlEl.removeAttribute('data-window-frost');
        }

        var wallpaperId = localStorage.getItem('knorvia-wallpaper') || 'none';
        var wallpaperSrc = null;
        var wallpaperFit = localStorage.getItem('knorvia-wallpaper-fit') || 'cover';
        var wallpaperDim = parseInt(localStorage.getItem('knorvia-wallpaper-dim') || '38', 10);
        if (wallpaperFit !== 'contain') wallpaperFit = 'cover';
        if (!(wallpaperDim >= 0 && wallpaperDim <= 100)) wallpaperDim = 38;
        if (wallpaperId && wallpaperId !== 'none' && wallpaperId !== 'custom') {
          wallpaperSrc = '/wallpapers/' + wallpaperId + '.jpg';
        }
        htmlEl.style.setProperty('--wallpaper-fit', wallpaperFit);
        htmlEl.style.setProperty('--wallpaper-dim', wallpaperDim + '%');
        if (wallpaperSrc) {
          htmlEl.setAttribute('data-wallpaper', wallpaperId);
          htmlEl.style.setProperty('--wallpaper-image', 'url("' + wallpaperSrc + '")');
        } else {
          htmlEl.removeAttribute('data-wallpaper');
        }

        if (window.knorviaDesktop) {
          var chromeApi = window.knorviaDesktop.chrome;
          var platform = (chromeApi && chromeApi.platform) || 'unknown';
          htmlEl.setAttribute('data-desktop-chrome', platform);
          var storedTheme = localStorage.getItem('knorvia-theme');
          var symbol = '#0d0d0d';
          var fill = '#ffffff';
          if (storedTheme === 'dark') { fill = '#1a1918'; symbol = '#e8e4de'; }
          else if (storedTheme === 'glass') { fill = '#eaf2f8'; symbol = '#10151c'; }
          else if (storedTheme === 'light') { fill = '#fdfcf9'; symbol = '#1c1816'; }
          if (chromeApi && chromeApi.setTitleBarOverlay && chromeApi.captionOverlay) {
            chromeApi.setTitleBarOverlay(frostOn ? { color: '#00000000', symbolColor: symbol } : { color: fill, symbolColor: symbol });
          }
          if (chromeApi && chromeApi.setWindowMaterial) {
            var material = { material: 'none', backgroundColor: fill, vibrancy: null };
            if (frostOn && platform === 'win32') material = { material: 'acrylic', backgroundColor: '#00000000', vibrancy: null };
            else if (frostOn && platform === 'darwin') material = { material: 'none', backgroundColor: '#00000000', vibrancy: 'under-window' };
            chromeApi.setWindowMaterial(material);
          }
        }
      } catch (e) {
        /* localStorage may be disabled */
      }
    })();
  `;

  return (
    <script
      dangerouslySetInnerHTML={{ __html: themeScript }}
      suppressHydrationWarning
    />
  );
}
