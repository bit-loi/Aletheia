/**
 * tokens.js — the single source of truth for Aletheia's design values.
 *
 * Loaded as a CLASSIC script by both surfaces:
 *
 *   - Content scripts (manifest.json content_scripts[0].js, and the mirrored
 *     dynamic-injection list in service-worker.js) communicate through
 *     window.Aletheia. They cannot use `import`.
 *   - popup/popup.html loads this in <head> with a data-al-inject attribute,
 *     which makes it self-inject a <style> into the document. A blocking
 *     classic script in <head> runs before the render-blocking stylesheets,
 *     so the tokens are in the cascade before first paint and there is no FOUC.
 *
 * Why custom properties specifically: content.css applies an important
 * all-initial reset to the <aletheia-root> host, and the `all` shorthand
 * explicitly does NOT reset custom properties. So :host declarations of --al-*
 * survive that reset and inherit normally into the shadow tree, while ordinary
 * inherited properties (font-family, color) do not. Every token is namespaced
 * --al- so a host page cannot collide with it.
 */

window.Aletheia = window.Aletheia || {};

/* ── Tier 1: primitives, identical in every theme ───────────────────────── */
const BASE = `
  --al-space-1: 4px;
  --al-space-2: 8px;
  --al-space-3: 12px;
  --al-space-4: 16px;
  --al-space-5: 24px;
  --al-space-6: 32px;

  --al-text-2xs: 10px;
  --al-text-xs:  11px;
  --al-text-sm:  12px;
  --al-text-md:  13px;
  --al-text-lg:  15px;
  --al-text-xl:  18px;

  --al-radius-xs: 4px;
  --al-radius-sm: 8px;
  --al-radius-md: 12px;
  --al-radius-lg: 16px;

  --al-hairline: 1px;
  --al-focus-width: 2px;

  --al-dur-1: 90ms;
  --al-dur-2: 160ms;
  --al-dur-3: 240ms;
  --al-dur-4: 320ms;
  --al-stagger: 40ms;
  --al-ease-out: cubic-bezier(0.32, 0.72, 0, 1);
  --al-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);

  --al-blur: 20px;
  --al-sat: 180%;

  --al-font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --al-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
`;

/* ── Tier 2: semantic, per theme ────────────────────────────────────────── */

/*
 * Glass tint alpha is the contrast floor, so it is derived rather than picked.
 *
 * Dark: white ink over tint #0A0A0C, worst case a pure-white article behind.
 * WCAG AA against white ink needs composite sRGB <= 119, and
 * 255(1-a) + 10a <= 119 gives a >= 0.56. Shipping 0.72 leaves headroom:
 * about 8.4:1 over white, about 20:1 over black video.
 */
const DARK = `
  --al-surface:        #0B0B0D;
  --al-surface-raised: #141418;
  --al-ink:            #FAFAFA;
  --al-ink-muted:      #A1A1AA;

  --al-border-hairline: rgba(255, 255, 255, 0.16);
  --al-border-strong:   rgba(255, 255, 255, 0.92);

  --al-glass-tint:      rgba(10, 10, 12, 0.72);
  --al-glass-highlight: rgba(255, 255, 255, 0.22);
  --al-glass-shade:     rgba(0, 0, 0, 0.35);

  --al-focus: #7DB8FF;

  --al-elev-1: 0 4px 16px rgba(0, 0, 0, 0.38);
  --al-elev-2: 0 16px 48px rgba(0, 0, 0, 0.52);

  --al-v-true-accent:        #10B981;
  --al-v-true-ink:           #34D399;
  --al-v-false-accent:       #EF4444;
  --al-v-false-ink:          #F87171;
  --al-v-misleading-accent:  #F59E0B;
  --al-v-misleading-ink:     #FBBF24;
  --al-v-unverified-accent:  #71717A;
  --al-v-unverified-ink:     #A1A1AA;
`;

/*
 * Light: black ink over a white tint, worst case a black video behind.
 * AA needs composite >= 116, and 255a >= 116 gives a >= 0.46.
 * Shipping 0.68 gives about 9.4:1 over black.
 */
const LIGHT = `
  --al-surface:        #FFFFFF;
  --al-surface-raised: #F4F4F5;
  --al-ink:            #18181B;
  --al-ink-muted:      #52525B;

  --al-border-hairline: rgba(0, 0, 0, 0.14);
  --al-border-strong:   rgba(0, 0, 0, 0.88);

  --al-glass-tint:      rgba(255, 255, 255, 0.68);
  --al-glass-highlight: rgba(255, 255, 255, 0.90);
  --al-glass-shade:     rgba(0, 0, 0, 0.12);

  --al-focus: #0B63CE;

  --al-elev-1: 0 4px 16px rgba(0, 0, 0, 0.12);
  --al-elev-2: 0 16px 48px rgba(0, 0, 0, 0.18);

  --al-v-true-accent:        #059669;
  --al-v-true-ink:           #047857;
  --al-v-false-accent:       #DC2626;
  --al-v-false-ink:          #B91C1C;
  --al-v-misleading-accent:  #D97706;
  --al-v-misleading-ink:     #B45309;
  --al-v-unverified-accent:  #71717A;
  --al-v-unverified-ink:     #52525B;
`;

/*
 * Accessibility and capability fallbacks.
 *
 * All of these work by redeclaring TOKENS rather than components, which is the
 * entire payoff of having a token layer: one block each, and every component
 * that consumes the token degrades automatically.
 *
 * The glass is an approximation of a liquid-glass material built from
 * backdrop-filter, layered borders and a specular highlight. It is not Apple's
 * material; there is no official liquid-glass.css for the web.
 */
function fallbacks(root) {
  return `
  @supports not (backdrop-filter: blur(2px)) {
    ${root} {
      --al-blur: 0px;
      --al-glass-tint: var(--al-surface);
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    ${root} {
      --al-blur: 0px;
      --al-glass-tint: var(--al-surface);
    }
  }
  @media (prefers-contrast: more) {
    ${root} {
      --al-blur: 0px;
      --al-glass-tint: var(--al-surface);
      --al-border-hairline: var(--al-border-strong);
      --al-focus-width: 3px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    ${root} {
      --al-dur-1: 1ms;
      --al-dur-2: 1ms;
      --al-dur-3: 1ms;
      --al-dur-4: 1ms;
      --al-stagger: 0ms;
    }
  }`;
}

/**
 * Build the token stylesheet.
 *
 * @param {string} root  selector carrying base + dark tokens (':host' or ':root')
 * @param {string} light selector carrying the light overrides
 * @returns {string} CSS
 */
window.Aletheia.tokensCSS = function tokensCSS(root, light) {
  return `${root} {${BASE}${DARK}}\n${light} {${LIGHT}}\n${fallbacks(root)}`;
};

/*
 * Self-injection for ordinary document contexts (the popup).
 * Opt in with: <script src="../shared/tokens.js" data-al-inject
 *                data-al-root=":root" data-al-light="body.light-theme"></script>
 */
(function selfInject() {
  const tag = document.currentScript;
  if (!tag || !tag.hasAttribute('data-al-inject')) return;
  const style = document.createElement('style');
  style.setAttribute('data-al-tokens', '');
  style.textContent = window.Aletheia.tokensCSS(
    tag.dataset.alRoot || ':root',
    tag.dataset.alLight || 'body.light-theme'
  );
  (document.head || document.documentElement).appendChild(style);
})();
