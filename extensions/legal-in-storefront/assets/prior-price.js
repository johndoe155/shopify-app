/* Variant IDs remain strings: never round Shopify's 64-bit identifiers. */
(() => {
  if (window.__legalInPriorPrice) return;
  window.__legalInPriorPrice = true;
  const selector = '[data-legal-in-block="prior-price"]';

  // Shopify money formats use a small set of amount placeholders. Render as
  // text, never as HTML: a merchant-controlled money format is not trusted markup.
  function formatMoney(amount, format) {
    if (!Number.isFinite(amount)) return null;
    const match = (format || '').match(/\{\{\s*(\w+)\s*\}\}/);
    // Unknown money format: fall back to a plain grouped amount rather than
    // rendering nothing (that used to blank the block on custom formats).
    if (!match) return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const kind = match[1];
    const formats = {
      amount: [2, ',', '.'], amount_no_decimals: [0, ',', '.'],
      amount_with_comma_separator: [2, '.', ','],
      amount_no_decimals_with_comma_separator: [0, '.', ','],
      amount_with_space_separator: [2, ' ', ','],
      amount_no_decimals_with_space_separator: [0, ' ', ','],
      amount_with_apostrophe_separator: [2, "'", '.'],
    };
    const spec = formats[kind];
    if (!spec) return null;
    const [decimals, thousands, decimal] = spec;
    const [whole, fraction] = amount.toFixed(decimals).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    const formatted = grouped + (fraction ? decimal + fraction : '');
    // Do not inject merchant-supplied HTML. Preserve common currency entities.
    return format.replace(match[0], formatted).replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot);/gi, (entity, code) => {
      const named = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"' };
      if (code[0] !== '#') return named[code.toLowerCase()] || entity;
      const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    });
  }

  function currentId(block) {
    const scope = block.closest('.shopify-section') || block.parentElement;
    if (!scope) return null;
    const input = scope.querySelector('form[action*="/cart/add"] [name="id"], [name="id"][form]');
    if (!input) return null;
    if (input.disabled || !input.value) return "";
    return String(input.value);
  }

  /**
   * The variant's live prices. Shopify renders them on the product JSON script
   * tag that every theme ships (and on the option inputs where present), so the
   * block can re-check "is this variant actually on sale" after a client-side
   * variant switch instead of trusting the stored `show` flag.
   */
  function readProduct(block) {
    if (block.__legalInProduct !== undefined) return block.__legalInProduct;
    const scope = block.closest('.shopify-section') || block.parentElement || document;
    let product = null;
    const json = scope.querySelector('script[type="application/json"][data-product-json], script[data-product-json]') ||
      document.querySelector('script[type="application/json"][data-product-json]');
    if (json) {
      try { product = JSON.parse(json.textContent || 'null'); } catch { product = null; }
    }
    block.__legalInProduct = product;
    return product;
  }

  function livePrices(block, id) {
    const product = readProduct(block);
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const variant = variants.find((candidate) => String(candidate.id) === id);
    if (!variant) return null;
    const price = Number(variant.price);
    const compareAt = variant.compare_at_price === null || variant.compare_at_price === undefined
      ? null : Number(variant.compare_at_price);
    if (!Number.isFinite(price)) return null;
    return { price, compareAt: Number.isFinite(compareAt) ? compareAt : null };
  }

  function update(block) {
    const id = currentId(block);
    // If the theme does not expose a product form, do not destroy the valid
    // server-rendered value. Theme-specific verification is still required.
    if (id === null) return;
    if (block.dataset.renderedId === id) return;
    block.dataset.renderedId = id;
    let prior;
    try { prior = JSON.parse(block.dataset.prior || 'null'); } catch { prior = null; }
    const variants = Array.isArray(prior?.variants) ? prior.variants : [];
    const entry = variants.find((v) => String(v.variant_id) === id || v.variant_id === `gid://shopify/ProductVariant/${id}`);

    // The stored `show` flag is never trusted on its own: the sale may have
    // ended, or the payload may predate the current price. The live prices decide
    // when the theme exposes them; only a product object with no price at all
    // falls back to the stored pair (the same rule as the Liquid, so a variant
    // switch cannot re-show a prior price the server hid).
    let ontSale = false;
    const live = livePrices(block, id);
    if (live && live.price > 0) {
      const compareAt = live.compareAt !== null && live.compareAt > 0 ? live.compareAt : null;
      if (entry && entry.price != null) {
        // The payload is written in rupees; the product JSON is in paise, like
        // Liquid. Convert the stored figure before comparing, or the block never
        // matches on a real store.
        const priceMatches = Math.round(Number(entry.price) * 100) === live.price;
        ontSale = priceMatches && compareAt !== null && compareAt > live.price;
      } else {
        // Legacy payload without prices: it only listed reduced variants.
        ontSale = compareAt !== null && compareAt > live.price;
      }
    } else if (entry) {
      const entryPrice = Number(entry.price);
      const entryCompare = Number(entry.compare_at);
      if (Number.isFinite(entryPrice) && Number.isFinite(entryCompare)) ontSale = entryCompare > entryPrice;
      else ontSale = true; // legacy payload: no prices stored to compare
    }
    const amount = entry && entry.show && entry.prior_price != null && ontSale
      ? formatMoney(Number(entry.prior_price), block.dataset.moneyFormat) : null;
    if (amount === null) {
      // This product has prior-price data but not for the selected variant.
      // Hide the content with `visibility` so the block keeps its height: using
      // `hidden`/display:none here would pull the rest of the page up on every
      // variant switch, which is exactly the layout shift this block must avoid.
      if (variants.length > 0) {
        block.classList.add('legal-in--idle');
        block.classList.remove('legal-in--ready');
        const value = block.querySelector('[data-prior-value]');
        const note = block.querySelector('[data-prior-note]');
        if (value) value.textContent = '';
        if (note) note.textContent = '';
      } else {
        // No prior-price data anywhere on this product: remove the box, which is
        // also the state the server rendered, so nothing moves.
        block.hidden = true;
      }
      return;
    }
    block.querySelector('[data-prior-value]').textContent = amount;
    // One wording only: a prior price comes from a complete 30-day lookback
    // before the reduction was announced, so there is no shorter-history
    // variant to describe here (audit item L16 removed the "tracked since
    // install" wording entirely).
    block.querySelector('[data-prior-note]').textContent =
      'Lowest price in the 30 days before the reduction was announced, inclusive of taxes.';
    // Same box, different text: no reflow of the surrounding content.
    block.classList.remove('legal-in--idle');
    block.classList.add('legal-in--ready');
    block.hidden = false;
  }

  function updateAll() { document.querySelectorAll(selector).forEach(update); }
  let timer;
  function schedule() {
    clearInterval(timer);
    updateAll();
    // Themes often replace the form asynchronously or change input.value without
    // an event. A bounded poll catches both without a permanent timer.
    let remaining = 30;
    timer = setInterval(() => {
      updateAll();
      if (--remaining === 0) clearInterval(timer);
    }, 100);
  }
  ['change', 'input', 'variant:change', 'variant:update', 'variant:changed', 'shopify:section:load'].forEach((event) => document.addEventListener(event, schedule));
  window.addEventListener('popstate', schedule);
  let observer;
  const start = () => {
    if (observer) return;
    updateAll();
    observer = new MutationObserver(updateAll);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    if (observer) observer.disconnect();
    observer = null;
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
