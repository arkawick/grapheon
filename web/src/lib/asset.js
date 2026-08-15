/**
 * Build a URL for something served alongside the app.
 *
 * Everything here used to be an absolute `/data/…`, which is correct at a
 * site root and silently wrong anywhere else. GitHub Pages serves a project
 * site from a SUBPATH (`/grapheon/`), so `/data/x.json` resolves to
 * `github.io/data/x.json` — a 404, after which the app sits on "Loading
 * atlas…" forever with no error that points at the cause.
 *
 * `import.meta.env.BASE_URL` is whatever `base` was set to at build time; it
 * always has a trailing slash and defaults to `/`. So paths passed here must
 * be RELATIVE — no leading slash — or they'd escape the base again.
 */
export function assetUrl(path) {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base}${String(path).replace(/^\/+/, '')}`;
}
