# Researching the lock and measuring its tokens

Two procedures `designing-ui` points at: how to research a direction (or a screen with
no precedent) when no research skill or tool is installed, and how to compute the
contrast ratio of a token pair from `src/app/globals.css`.

## Research, when there is no `refero-design`

Nothing below needs a named skill, an MCP server, or a browsing tool. A session that can
open web pages uses them; one that cannot asks the owner for the names and links, and
still does the writing itself.

1. **Start from the product, not the palette.** Read the product description in
   AGENTS.md, once it has one, or ask the owner: who uses the app, what the main screen
   is for, and what the app must never feel like. Every later choice is judged against
   that answer, not against taste.
2. **Collect three to five references in the same category** — shipped products a user
   of this app would also use, not concept shots or a gallery of mockups. For each,
   write one line on what to keep and one on what to leave.
3. **Pick one primary reference and say why.** It is the one whose visual system fits
   the product's job, which is not always the most attractive one. A second reference
   contributes only the named pieces that go under "Borrow only".
4. **Draft the lock fields** from those notes. Each field names the reference it came
   from; a field with no source is taste, and goes back to step 2.
5. **Ask the owner where the references disagree** — density, rules versus shadows, one
   accent or two. Ask once, with every open point, each set out as options side by side
   with the reference behind each and what it costs. Never settle a disagreement by
   averaging the two: the middle is the generic screen the lock exists to prevent.

Every reference is written down — product, URL, and the date it was viewed — in the
ledger rows that cite it, so a later reader can reopen exactly what the decision was
made from.

For a screen with no precedent, run steps 2, 3 and 5 on that surface alone, then adapt
what was found to the existing lock. A finding that conflicts with the lock goes to step
5 rather than quietly loosening it.

## Computing a contrast ratio

The stock tokens are OKLCH, and OKLCH lightness is not WCAG relative luminance — a pair
that looks safe by its `L` values can fail. Convert each value to sRGB, then apply the
WCAG 2.x formula; a value already written as hex or `rgb()` skips the conversion, each
channel divided by 255. A token with alpha (the stock dark `--border` and `--input`) is
first composited over the surface it sits on.

The thresholds are 4.5:1 for body text, and 3:1 for large text (at least 24px, or about
18.5px bold) and for the boundary of a control, a focus ring, or an icon that carries
meaning (<https://www.w3.org/TR/WCAG22/> success criteria 1.4.3 and 1.4.11, and
<https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html> for the pixel sizes,
both checked 2026-10-01).

Run this from a scratch file outside the checkout; it is a measurement, not a module,
and needs no package:

```js
// OKLCH -> gamma-encoded sRGB channels in [0, 1], clipped to the gamut.
function oklchToSrgb(l, c, hDegrees) {
  const h = (hDegrees * Math.PI) / 180;
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const [L, M, S] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  });
}

// A token with alpha, composited over the surface it sits on.
const over = (top, alpha, bottom) =>
  top.map((v, i) => alpha * v + (1 - alpha) * bottom[i]);

// WCAG 2.x relative luminance and contrast ratio.
function luminance(srgb) {
  const [r, g, b] = srgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(x, y) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

// Self-check: oklch(0.556 0 0) on oklch(1 0 0) is 4.73.
console.log(contrast(oklchToSrgb(0.556, 0, 0), oklchToSrgb(1, 0, 0)).toFixed(2));
```

The last line is the check on the script itself: if it does not print `4.73`, the
conversion is wrong, and no ratio it reports can be trusted.

Record the result in the pull request as one row per pair and scheme:

```text
Pair                                      Scheme  Ratio   Needs
--muted-foreground on --background        light   4.73:1  4.5:1
--muted-foreground on --background        dark    7.63:1  4.5:1
```
