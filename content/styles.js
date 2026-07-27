/**
 * styles.js: Aletheia overlay theme constants & Shadow DOM stylesheet.
 *
 * Design language: "glass chrome, opaque content."
 *
 * The chrome (header, controls, minimized pill) is a web approximation of a
 * liquid-glass material: backdrop-filter blur + saturation, a tint that doubles
 * as the contrast scrim, layered inset borders and a static specular sheen.
 * This is NOT Apple's material; there is no official liquid-glass.css for the
 * web, and this should not be described as one.
 *
 * Content (claim cards, verdict text) sits on an OPAQUE surface. The panel
 * floats over live video and articles where backdrop luminance changes every
 * frame, and legibility is the product for a fact-checker. Text on blur would
 * shimmer in and out of readability.
 *
 * All values come from shared/tokens.js. Do not hardcode colours, sizes,
 * radii, durations or shadows in this file.
 */

window.Aletheia = window.Aletheia || {};

/**
 * Verdict labels. Colour lives in tokens and is selected via [data-verdict];
 * this object deliberately carries no colour values.
 */
window.Aletheia.VERDICT_META = {
  True:       { label: 'True',       key: 'true' },
  False:      { label: 'False',      key: 'false' },
  Misleading: { label: 'Misleading', key: 'misleading' },
  Unverified: { label: 'Unverified', key: 'unverified' },
};

const COMPONENTS = `
  /* ── Panel: transparent layout shell ──────────────────────────────────────
     No background and no overflow clip. backdrop-filter samples what is painted
     behind an element, so a filled panel would frost its own fill. Never
     animate opacity here: an ancestor with opacity < 1 becomes a backdrop root
     and the chrome's glass would flatly vanish mid-transition. */
  .al-panel {
    position: fixed;
    top: 96px;
    right: 24px;
    width: 372px;
    max-height: 74vh;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    font-family: var(--al-font-ui);
    font-size: var(--al-text-md);
    line-height: 1.5;
    color: var(--al-ink);
    border-radius: var(--al-radius-lg);
    filter: drop-shadow(var(--al-elev-2));
    transition: transform var(--al-dur-3) var(--al-ease-out);
  }

  .al-panel.is-hidden {
    visibility: hidden;
    transform: translateY(-8px) scale(0.96);
    transform-origin: var(--al-origin-x, 100%) var(--al-origin-y, 0%);
    transition: transform var(--al-dur-2) var(--al-ease-out),
                visibility 0s linear var(--al-dur-2);
  }

  .al-panel.is-dragging { transition: none; }

  /* ── Glass chrome ─────────────────────────────────────────────────────── */
  .al-chrome,
  .al-ctrl,
  .al-fab {
    position: relative;
    isolation: isolate;
    background: var(--al-glass-tint);
    backdrop-filter: blur(var(--al-blur)) saturate(var(--al-sat));
    -webkit-backdrop-filter: blur(var(--al-blur)) saturate(var(--al-sat));
    border: var(--al-hairline) solid var(--al-border-hairline);
    box-shadow: inset 0 1px 0 var(--al-glass-highlight),
                inset 0 -1px 0 var(--al-glass-shade);
  }

  /* Static specular sheen. A cursor-tracking highlight would repaint the blur
     on every mousemove over a playing video; not worth it at this density. */
  .al-chrome::before,
  .al-ctrl::before,
  .al-fab::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 42%);
  }

  .al-chrome {
    display: flex;
    align-items: center;
    gap: var(--al-space-2);
    padding: var(--al-space-2) var(--al-space-2) var(--al-space-2) var(--al-space-1);
    border-radius: var(--al-radius-lg) var(--al-radius-lg) 0 0;
    border-bottom: none;
    cursor: grab;
    user-select: none;
  }
  .al-panel.is-dragging .al-chrome { cursor: grabbing; }

  /* ── Drag grip ────────────────────────────────────────────────────────── */
  .al-grip {
    flex: none;
    width: 18px;
    height: 26px;
    display: grid;
    place-items: center;
    background: none;
    border: none;
    border-radius: var(--al-radius-xs);
    cursor: grab;
    padding: 0;
  }
  .al-grip__dots {
    width: 3px;
    height: 15px;
    border-radius: 2px;
    background-image: radial-gradient(currentColor 44%, transparent 46%);
    background-size: 3px 5px;
    color: var(--al-ink-muted);
    opacity: 0.75;
  }

  /* ── Identity + status ────────────────────────────────────────────────── */
  .al-ident {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .al-brand {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-xs);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--al-ink);
  }
  .al-status {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    color: var(--al-ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: opacity var(--al-dur-2) var(--al-ease-standard);
  }
  /* Consecutive status strings otherwise teleport and read as a glitch. */
  .al-status.is-swapping { opacity: 0; }
  .al-status.is-active { color: var(--al-ink); }

  /* ── Controls ─────────────────────────────────────────────────────────── */
  .al-actions { display: flex; gap: var(--al-space-1); flex: none; }
  .al-ctrl {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: var(--al-radius-xs);
    color: var(--al-ink);
    font-size: var(--al-text-md);
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition: transform var(--al-dur-1) var(--al-ease-standard),
                background-color var(--al-dur-1) var(--al-ease-standard);
  }
  .al-ctrl:hover { background: var(--al-glass-highlight); }
  .al-ctrl:active { transform: translate(1px, 1px); }

  /* ── Progress ─────────────────────────────────────────────────────────── */
  .al-progress {
    height: 2px;
    background: var(--al-surface-raised);
    overflow: hidden;
    opacity: 0;
    transition: opacity var(--al-dur-2) var(--al-ease-standard);
  }
  .al-progress.is-visible { opacity: 1; }
  .al-progress__fill {
    height: 100%;
    width: 0%;
    background: var(--al-ink);
    transition: width var(--al-dur-4) var(--al-ease-standard);
  }
  .al-progress.is-indeterminate .al-progress__fill {
    width: 36%;
    animation: al-sweep 1400ms var(--al-ease-standard) infinite;
  }
  @keyframes al-sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(380%); }
  }

  /* ── Body: the opaque plane ───────────────────────────────────────────── */
  .al-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--al-surface);
    border: var(--al-hairline) solid var(--al-border-hairline);
    border-top: none;
    border-radius: 0 0 var(--al-radius-lg) var(--al-radius-lg);
    scrollbar-width: thin;
    scrollbar-color: var(--al-ink-muted) transparent;
  }
  .al-body::-webkit-scrollbar { width: 8px; }
  .al-body::-webkit-scrollbar-thumb {
    background: var(--al-border-hairline);
    border-radius: var(--al-radius-sm);
  }

  .al-feed {
    display: flex;
    flex-direction: column;
    gap: var(--al-space-2);
    padding: var(--al-space-3);
  }

  /* ── Placeholder / empty / setup / no-claims ──────────────────────────── */
  .al-placeholder { padding: var(--al-space-5) var(--al-space-3); text-align: center; }
  .al-placeholder__title {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--al-ink);
    margin-bottom: var(--al-space-2);
  }
  .al-placeholder__body {
    font-size: var(--al-text-sm);
    color: var(--al-ink-muted);
    line-height: 1.55;
    max-width: 32ch;
    margin: 0 auto;
  }

  /* ── Skeleton ─────────────────────────────────────────────────────────── */
  .al-skeleton {
    display: flex;
    gap: var(--al-space-3);
    padding: var(--al-space-3);
    border: var(--al-hairline) solid var(--al-border-hairline);
    border-radius: var(--al-radius-md);
    background: var(--al-surface-raised);
  }
  .al-skeleton__rail {
    flex: none;
    width: 3px;
    border-radius: 2px;
    background: var(--al-border-hairline);
  }
  .al-skeleton__lines { flex: 1; display: flex; flex-direction: column; gap: var(--al-space-2); }
  .al-skeleton__line {
    position: relative;
    display: block;
    height: 9px;
    border-radius: var(--al-radius-xs);
    background: var(--al-border-hairline);
    overflow: hidden;
  }
  .al-skeleton__line--badge { width: 38%; height: 12px; }
  .al-skeleton__line--short { width: 62%; }
  /* Transform-based so the shimmer stays on the compositor. */
  .al-skeleton__line::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, var(--al-glass-highlight), transparent);
    animation: al-shimmer 1200ms linear infinite;
  }
  @keyframes al-shimmer {
    from { transform: translateX(-100%); }
    to   { transform: translateX(200%); }
  }

  /* ── Claim card ───────────────────────────────────────────────────────── */
  .al-card {
    display: flex;
    gap: var(--al-space-3);
    padding: var(--al-space-3);
    background: var(--al-surface-raised);
    border: var(--al-hairline) solid var(--al-border-hairline);
    border-radius: var(--al-radius-md);
    animation: al-card-in var(--al-dur-4) var(--al-ease-out) backwards;
    animation-delay: calc(var(--al-card-index, 1) * var(--al-stagger));
  }
  @keyframes al-card-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  .al-card__main { flex: 1; min-width: 0; }

  /* The rail is the primary scan target and the only animated colour. */
  .al-card__rail {
    flex: none;
    width: 3px;
    border-radius: 2px;
    background: var(--v-accent);
    transform: scaleY(0);
    transform-origin: top;
    animation: al-rail-in var(--al-dur-4) var(--al-ease-out) forwards;
    animation-delay: calc(var(--al-card-index, 1) * var(--al-stagger) + 80ms);
  }
  @keyframes al-rail-in { to { transform: scaleY(1); } }

  /* Verdict tokens, plus a non-colour rail pattern so the verdict survives
     grayscale and colour-vision deficiency. */
  .al-card[data-verdict="true"]       { --v-accent: var(--al-v-true-accent);       --v-ink: var(--al-v-true-ink); }
  .al-card[data-verdict="false"]      { --v-accent: var(--al-v-false-accent);      --v-ink: var(--al-v-false-ink); }
  .al-card[data-verdict="misleading"] { --v-accent: var(--al-v-misleading-accent); --v-ink: var(--al-v-misleading-ink); }
  .al-card[data-verdict="unverified"] { --v-accent: var(--al-v-unverified-accent); --v-ink: var(--al-v-unverified-ink); }

  .al-card[data-verdict="false"] .al-card__rail {
    background: linear-gradient(var(--v-accent) 0 44%, transparent 44% 56%, var(--v-accent) 56% 100%);
  }
  .al-card[data-verdict="misleading"] .al-card__rail {
    background: repeating-linear-gradient(45deg, var(--v-accent) 0 3px, transparent 3px 6px);
  }
  .al-card[data-verdict="unverified"] .al-card__rail {
    background: repeating-linear-gradient(180deg, var(--v-accent) 0 3px, transparent 3px 7px);
  }

  .al-card__head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--al-space-2);
    margin-bottom: var(--al-space-2);
  }

  .al-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--al-space-1);
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--v-ink);
  }
  .al-badge__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v-accent);
  }

  /* Confidence stays monochrome so it does not compete with the verdict. */
  .al-meter { display: inline-flex; align-items: center; gap: 3px; }
  .al-meter__seg {
    width: 4px;
    height: 8px;
    border-radius: 1px;
    background: var(--al-border-hairline);
  }
  .al-meter__seg.is-on { background: var(--al-ink-muted); }
  .al-meter__label {
    margin-left: var(--al-space-1);
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    text-transform: lowercase;
    color: var(--al-ink-muted);
  }

  .al-chip {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--al-ink-muted);
    border: var(--al-hairline) solid var(--al-border-hairline);
    border-radius: var(--al-radius-xs);
    padding: 1px var(--al-space-1);
  }

  .al-claim {
    margin: 0 0 var(--al-space-2);
    font-size: var(--al-text-md);
    font-weight: 600;
    line-height: 1.45;
    color: var(--al-ink);
  }
  .al-explain {
    margin: 0 0 var(--al-space-2);
    font-size: var(--al-text-sm);
    line-height: 1.55;
    color: var(--al-ink-muted);
  }

  /* ── Sources disclosure ───────────────────────────────────────────────── */
  .al-sources__toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--al-space-1);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--al-ink-muted);
  }
  .al-sources__toggle:hover { color: var(--al-ink); }
  .al-sources__arrow {
    width: 0;
    height: 0;
    border-left: 4px solid currentColor;
    border-top: 3px solid transparent;
    border-bottom: 3px solid transparent;
    transition: transform var(--al-dur-2) var(--al-ease-standard);
  }
  .al-sources__toggle[aria-expanded="true"] .al-sources__arrow { transform: rotate(90deg); }

  /* grid-template-rows animates height with no JS measurement. */
  .al-sources__wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--al-dur-2) var(--al-ease-standard);
  }
  .al-sources__wrap.is-open { grid-template-rows: 1fr; }
  .al-sources__list { overflow: hidden; margin: 0; padding: 0; list-style: none; }
  .al-sources__wrap.is-open .al-sources__list { padding-top: var(--al-space-2); }
  .al-sources__list li { margin-bottom: var(--al-space-1); }
  .al-sources__list a {
    font-size: var(--al-text-xs);
    color: var(--al-ink-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .al-sources__list a:hover { color: var(--al-ink); }
  .al-sources__empty {
    font-size: var(--al-text-xs);
    color: var(--al-ink-muted);
    font-style: italic;
  }

  /* ── Error ────────────────────────────────────────────────────────────── */
  .al-error {
    padding: var(--al-space-3);
    border: var(--al-hairline) solid var(--al-v-false-accent);
    border-radius: var(--al-radius-md);
    background: var(--al-surface-raised);
  }
  .al-error__title {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--al-v-false-ink);
    margin-bottom: var(--al-space-2);
  }
  .al-error__body {
    font-size: var(--al-text-sm);
    line-height: 1.55;
    color: var(--al-ink-muted);
  }
  .al-retry {
    margin-top: var(--al-space-3);
    padding: var(--al-space-1) var(--al-space-3);
    font-family: var(--al-font-mono);
    font-size: var(--al-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--al-ink);
    background: none;
    border: var(--al-hairline) solid var(--al-border-hairline);
    border-radius: var(--al-radius-xs);
    cursor: pointer;
    transition: transform var(--al-dur-1) var(--al-ease-standard),
                background-color var(--al-dur-1) var(--al-ease-standard);
  }
  .al-retry:hover { background: var(--al-surface); }
  .al-retry:active { transform: translate(1px, 1px); }

  /* ── Minimized pill ───────────────────────────────────────────────────── */
  .al-fab {
    position: fixed;
    top: 96px;
    right: 24px;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: var(--al-radius-md);
    cursor: grab;
    pointer-events: auto;
    padding: 0;
    filter: drop-shadow(var(--al-elev-1));
    transition: transform var(--al-dur-2) var(--al-ease-out);
  }
  .al-fab:hover { transform: translateY(-1px); }
  .al-fab.is-hidden {
    visibility: hidden;
    transform: scale(0.9);
    transition: transform var(--al-dur-2) var(--al-ease-out),
                visibility 0s linear var(--al-dur-2);
  }
  .al-fab__glyph {
    font-family: var(--al-font-mono);
    font-size: var(--al-text-xl);
    font-weight: 700;
    color: var(--al-ink);
  }

  /* ── Focus ────────────────────────────────────────────────────────────── */
  .al-ctrl:focus-visible,
  .al-grip:focus-visible,
  .al-fab:focus-visible,
  .al-sources__toggle:focus-visible,
  .al-retry:focus-visible,
  .al-panel:focus-visible {
    outline: none;
  }
  /* On glass a plain outline can vanish against an arbitrary backdrop, so use a
     double ring: an opaque inner band, then the focus colour. */
  .al-ctrl:focus-visible,
  .al-grip:focus-visible,
  .al-fab:focus-visible {
    box-shadow: 0 0 0 2px var(--al-surface),
                0 0 0 calc(2px + var(--al-focus-width)) var(--al-focus);
  }
  .al-sources__toggle:focus-visible,
  .al-retry:focus-visible,
  .al-panel:focus-visible {
    outline: var(--al-focus-width) solid var(--al-focus);
    outline-offset: 2px;
  }

  /* ── Screen-reader-only live region ───────────────────────────────────── */
  .al-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* ── Reduced motion ───────────────────────────────────────────────────────
     Token durations already collapse to 1ms. Infinite and transform-based
     animations need removing outright rather than shortening. */
  @media (prefers-reduced-motion: reduce) {
    .al-card { animation: none; }
    .al-card__rail { animation: none; transform: none; }
    .al-skeleton__line::after { animation: none; opacity: 0.12; }
    .al-progress.is-indeterminate .al-progress__fill {
      animation: none;
      width: 100%;
      opacity: 0.35;
    }
    .al-panel.is-hidden { transform: none; }
    .al-fab:hover { transform: none; }
  }
`;

window.Aletheia.SHADOW_STYLES =
  window.Aletheia.tokensCSS(':host', ':host(.light-theme)') + COMPONENTS;
