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
          document.documentElement.classList.add('dark', 'theme-glass');
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
