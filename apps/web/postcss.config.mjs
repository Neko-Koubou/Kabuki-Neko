/**
 * PostCSS pipeline for the Next.js web app (TASK-087A).
 *
 * Tailwind CSS 4 runs as a single PostCSS plugin: it expands `@import "tailwindcss"`, the
 * `@theme` token mapping in `src/app/globals.css` and the utility classes used by components.
 * No other plugins are registered (Tailwind 4 already handles vendor prefixing and nesting).
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
