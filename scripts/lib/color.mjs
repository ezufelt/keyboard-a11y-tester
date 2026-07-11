// WCAG relative luminance of an 8-bit sRGB colour (for 1.4.1 / 2.4.13 contrast).
// Factored out of runner.mjs so it can be imported (and fuzzed) directly
// without triggering the CLI's own main()/browser launch.
export function relLum(r, g, b) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
