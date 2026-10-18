/**
 * The UI foundation: design tokens, the base layer, shared components and the
 * responsive overrides, in f1-game's cascade order (index.html:111-132 loads
 * tokens.css, components.css, …, responsive.css; tokens.css:13 declares
 * `@layer reset, base, components, hud, overlays`, so any stylesheet imported
 * after this module slots into those layers by name).
 *
 * Import this module once, first (src/main.ts). Screen CSS (data hub, HUD,
 * menus, editor…) stays with the lane that owns the screen, and imports this
 * module before its own sheet so the layer order is fixed even when a screen
 * module is loaded on its own (tests, a lazy chunk).
 */
import "./tokens.css";
import "./fonts-hud.css";
import "./components.css";
import "./responsive.css";

export * as CssZoom from "./css-zoom";
