import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names and let the last Tailwind utility of a group win.
 *
 * @remarks
 * Every shadcn/ui component copied into `src/components/ui/` calls this, which
 * is why it sits at the path `components.json`'s `aliases.utils` names. `clsx`
 * resolves the conditional forms (an array, an object, a falsy value) into one
 * string; `twMerge` then drops the earlier of two utilities that set the same
 * property, so a `className` passed by a caller overrides the component's own
 * default instead of racing it in the stylesheet.
 *
 * `twMerge` only knows Tailwind's default theme. A custom `--text-*` size
 * token added to `src/app/globals.css` is filed with the colors — `text-figure`
 * beside `text-muted-foreground` then silently loses the size — so a theme
 * that adds one swaps this for `extendTailwindMerge` naming it, as
 * `designing-ui` describes.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
