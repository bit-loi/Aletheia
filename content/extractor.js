/**
 * extractor.js: Page detection and article text extraction.
 *
 * Provides heuristics for:
 *   - Detecting YouTube watch pages vs. article pages
 *   - Extracting the main article text from any news page DOM
 *     (reader-mode style: prefers <article>, strips noise, falls back
 *      to the heaviest text-bearing container)
 *
 * Depends on: nothing (pure DOM utilities)
 * Loaded before: overlay.js, content.js
 */

window.Aletheia = window.Aletheia || {};

// ─── Page Detection ───────────────────────────────────────────────────────────

/**
 * Is the current page a YouTube video page?
 */
window.Aletheia.isYouTubePage = function () {
  const host = location.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return location.pathname.length > 1;
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return false;
  return location.pathname === '/watch' ||
    location.pathname.startsWith('/live/') ||
    location.pathname.startsWith('/shorts/');
};

/**
 * Heuristic: does this page look like it has a readable article?
 * Checks for <article> tags or substantial paragraph text (>500 chars).
 */
window.Aletheia.hasArticleContent = function () {
  if (window.Aletheia.isYouTubePage()) return false;

  // Check for <article> tag
  const article = document.querySelector('article');
  if (article && article.textContent.trim().length > 300) return true;

  // Check for main content area with substantial <p> text
  const main = document.querySelector('main, [role="main"]');
  const container = main || document.body;
  const paragraphs = container.querySelectorAll('p');
  let totalText = 0;
  paragraphs.forEach((p) => {
    totalText += p.textContent.trim().length;
  });

  return totalText > 500;
};

// ─── Article Text Extraction ──────────────────────────────────────────────────

/**
 * Selectors for elements that are almost always noise (nav, ads, footers…).
 * Matched elements are removed before extracting text.
 */
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe',
  'nav', 'aside', 'footer', 'header',
  'form', 'button', 'input', 'select', 'textarea',
  '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
  '.ad, .ads, .advertisement, .social-share, .share-buttons',
  '.sidebar, .widget, .related-posts, .recommended',
  '.comment, .comments, #comments',
  '.newsletter, .subscribe',
];

/**
 * Fallback: find the DOM element that contains the most paragraph text.
 * Scans all <div> and <section> elements and picks the one whose
 * descendant <p> tags have the highest total character count.
 *
 * @returns {Element|null}
 */
function findTextHeaviestContainer() {
  const candidates = document.querySelectorAll('div, section');
  let best = null;
  let bestScore = 0;

  candidates.forEach((el) => {
    const paragraphs = el.querySelectorAll('p');
    let score = 0;
    paragraphs.forEach((p) => {
      score += p.textContent.trim().length;
    });
    if (score > bestScore && score > 300) {
      bestScore = score;
      best = el;
    }
  });

  return best;
}

/**
 * Extracts the main article text from the current page DOM.
 *
 * Strategy (in priority order):
 *   1. <article> tag
 *   2. [role="main"] or <main>
 *   3. Common CMS content class names (.post-content, .entry-content, …)
 *   4. Heaviest text-bearing container (fallback)
 *
 * After selecting the root, noise elements are stripped and remaining
 * <p>/<h*>/<li>/<blockquote> text is concatenated.
 *
 * @returns {{ title: string, text: string }}
 */
window.Aletheia.extractArticleText = function () {
  // ── Find the best content root ──
  let root =
    document.querySelector('article') ||
    document.querySelector('[role="main"]') ||
    document.querySelector('main') ||
    document.querySelector('.post-content, .entry-content, .article-body, .story-body') ||
    null;

  if (!root) {
    root = findTextHeaviestContainer();
  }

  if (!root) {
    return { title: document.title, text: '' };
  }

  // ── Clone and clean ──
  const clone = root.cloneNode(true);

  NOISE_SELECTORS.forEach((sel) => {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  });

  // Extract text from meaningful content elements
  const textElements = clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
  const textParts = [];
  textElements.forEach((el) => {
    const t = el.textContent.trim();
    if (t.length > 20) {
      textParts.push(t);
    }
  });

  // ── Extract title ──
  const title =
    document.querySelector('h1')?.textContent.trim() ||
    document.querySelector('[property="og:title"]')?.content ||
    document.title;

  return {
    title: title.slice(0, 300),
    text: textParts.join('\n\n'),
  };
};
