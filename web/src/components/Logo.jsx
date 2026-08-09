/**
 * The Grapheon mark — an interlocking 86 monogram with the app's blue gradient.
 *
 * An <img> pointing at the generated `public/logo.svg` rather than inline SVG:
 * the gradient is baked into that one file, which is also what the favicon and
 * the Android launcher icons are built from, so there is a single source of
 * truth for the mark. Regenerate everything with `node scripts/make-logo.mjs`.
 *
 * The art is 1.545:1, so height is the dimension worth specifying; width
 * follows from it.
 */
export default function Logo({ height = 20, className = '' }) {
  return (
    <img
      className={`logo ${className}`.trim()}
      src="/logo.svg"
      alt="Grapheon"
      height={height}
      style={{ height, width: 'auto' }}
      draggable={false}
    />
  );
}
