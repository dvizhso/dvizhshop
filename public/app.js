/* ============================================================
   DVIZH FREIBURG — public shop
   Каталог, корзина и оформление заявки. Все данные — из /api/catalog.
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CART_KEY = 'dvizh_cart_v1';
  const ORDER_KEY = 'dvizh_order_key_v1';
  const API_BASE = String(window.SHOP_API_BASE || '').replace(/\/+$/, '');
  const apiUrl = (path) => `${API_BASE}${path}`;
  const assetUrl = (path) => {
    const value = String(path || '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
    return `${API_BASE}/${value.replace(/^\/+/, '')}`;
  };
  const overlays = [];
  let lastFocus = null;

  const state = {
    catalog: null,
    catalogRaw: '',
    initialLoaded: false,
    filter: 'all',
    search: '',
    cart: [],
    product: null,
    size: '',
    color: '',
    qty: 1,
    photo: 0,
    sending: false,
    idempotencyKey: '',
  };

  /* ---------------- helpers ---------------- */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function fmtMoney(cents) {
    const v = Math.round(Number(cents) || 0) / 100;
    return '€' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
  }

  function discountPercent(price, oldPrice) {
    if (!oldPrice || oldPrice <= price) return 0;
    return Math.max(1, Math.round((1 - price / oldPrice) * 100));
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function kindFor(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('зип')) return 'zip';
    if (n.includes('худи')) return 'hoodie';
    if (n.includes('свитшот')) return 'sweat';
    if (n.includes('лонгслив')) return 'long';
    if (n.includes('кепка') || n.includes('шапка') || n.includes('cap')) return 'cap';
    return 'tee';
  }

  function artEl(product) {
    return el('div', { class: 'art', 'data-kind': kindFor(product.name), 'aria-hidden': 'true' },
      el('span', { class: 'art-code', text: 'DZH-' + String(product.id).padStart(3, '0') }),
      el('span', { class: 'art-word', text: 'DVIZH' }),
      el('span', { class: 'art-city', text: 'FREIBURG · 2026' }),
    );
  }

  function productImage(product, src, alt, lazy = true) {
    const img = el('img', {
      src, alt: alt || product.name,
      loading: lazy ? 'lazy' : 'eager',
      decoding: 'async',
    });
    img.addEventListener('error', () => { img.replaceWith(artEl(product)); }, { once: true });
    return img;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add('show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => { node.hidden = true; }, 220);
    }, 2300);
  }

  function bumpCart() {
    const badge = $('cartCount');
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }

  /* ---------------- cart storage ---------------- */
  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x) => x && Number.isFinite(Number(x.productId)) && Number(x.qty) > 0)
        .map((x) => ({
          productId: Number(x.productId),
          size: String(x.size || ''),
          color: String(x.color || ''),
          qty: Math.min(20, Number(x.qty) || 1),
        }));
    } catch { return []; }
  }

  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* приватный режим */ }
  }

  function makeIdempotencyKey() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch { /* старый браузер */ }
    const bytes = new Uint8Array(16);
    (window.crypto || {}).getRandomValues?.(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') || `k${Date.now()}`;
  }

  // Повторная отправка той же корзины использует тот же ключ — сервер не создаст дубль.
  function idempotencyKeyForCart() {
    const fingerprint = JSON.stringify(state.cart
      .map((i) => [i.productId, i.size, i.color, i.qty])
      .sort((a, b) => String(a).localeCompare(String(b))));
    try {
      const saved = JSON.parse(sessionStorage.getItem(ORDER_KEY) || 'null');
      if (saved && saved.fingerprint === fingerprint && saved.key) return saved.key;
    } catch { /* приватный режим */ }
    const key = makeIdempotencyKey();
    try { sessionStorage.setItem(ORDER_KEY, JSON.stringify({ fingerprint, key })); } catch { /* ignore */ }
    return key;
  }

  function resetOrderKey() {
    state.idempotencyKey = '';
    try { sessionStorage.removeItem(ORDER_KEY); } catch { /* ignore */ }
  }

  function findProduct(id) {
    return (state.catalog?.products || []).find((p) => p.id === Number(id)) || null;
  }

  function reconcileCart() {
    const next = [];
    for (const item of state.cart) {
      const product = findProduct(item.productId);
      if (!product || product.stock <= 0) continue;
      const qty = Math.min(item.qty, product.stock);
      if (qty <= 0) continue;
      const size = product.sizes.includes(item.size) ? item.size : (product.sizes[0] || '');
      const color = product.colors.includes(item.color) ? item.color : (product.colors[0] || '');
      next.push({ ...item, size, color, qty });
    }
    state.cart = next;
    saveCart();
  }

  function cartTotal() {
    return state.cart.reduce((sum, item) => {
      const product = findProduct(item.productId);
      return sum + (product ? product.price * item.qty : 0);
    }, 0);
  }

  function cartCount() {
    return state.cart.reduce((sum, x) => sum + x.qty, 0);
  }

  function addToCart(product, size, color, qty) {
    if (!product || product.stock <= 0) { toast('Этого товара нет в наличии'); return; }
    const key = (i) => `${i.productId}|${i.size}|${i.color}`;
    const wanted = { productId: product.id, size, color, qty };
    const found = state.cart.find((i) => key(i) === key(wanted));
    const already = found ? found.qty : 0;
    const allowed = Math.min(product.stock, already + qty);
    if (allowed <= already) { toast('Больше нет в наличии'); return; }
    if (found) found.qty = allowed;
    else state.cart.push({ ...wanted, qty: allowed });
    saveCart();
    renderCart();
    bumpCart();
    toast('Добавлено в корзину');
  }

  function setQty(index, delta) {
    const item = state.cart[index];
    if (!item) return;
    const product = findProduct(item.productId);
    const max = product ? product.stock : 20;
    const next = item.qty + delta;
    if (next <= 0) {
      state.cart.splice(index, 1);
    } else if (next > max) {
      toast(`В наличии только ${max} ${plural(max, ['шт.', 'шт.', 'шт.'])}`);
      return;
    } else {
      item.qty = next;
    }
    saveCart();
    renderCart();
  }

  /* ---------------- catalog ---------------- */
  function normalizeCatalog(data) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      settings: data.settings || {},
      collections: Array.isArray(data.collections) ? data.collections.map((c) => ({
        id: num(c.id), name: String(c.name || ''), slug: String(c.slug || ''), description: String(c.description || ''),
      })) : [],
      banners: Array.isArray(data.banners) ? data.banners.map((b) => ({
        ...b,
        image: assetUrl(b.image),
        link: String(b.link || ''),
      })) : [],
      products: Array.isArray(data.products) ? data.products.map((p) => ({
        id: num(p.id),
        name: String(p.name || ''),
        slug: String(p.slug || ''),
        description: String(p.description || ''),
        price: num(p.price),
        oldPrice: p.oldPrice ? num(p.oldPrice) : 0,
        collection: p.collection ? num(p.collection) : 0,
        collectionName: String(p.collectionName || ''),
        sizes: Array.isArray(p.sizes) ? p.sizes.filter(Boolean) : [],
        colors: Array.isArray(p.colors) ? p.colors.filter(Boolean) : [],
        stock: num(p.stock),
        photos: Array.isArray(p.photos) ? p.photos.filter(Boolean).map(assetUrl) : [],
      })) : [],
    };
  }

  async function loadCatalog({ silent = false } = {}) {
    if (!silent) showSkeletons();
    try {
      const res = await fetch(apiUrl('/api/catalog'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.text();
      if (raw === state.catalogRaw) {
        hideLoadingStates();
        if (!silent) { renderProducts(); }
        return;
      }
      const data = normalizeCatalog(JSON.parse(raw));
      state.catalogRaw = raw;
      state.catalog = data;
      applySettings();
      renderBanners();
      reconcileCart();
      renderFilters();
      renderProducts();
      renderCart();
      updateCartCount();
      hideLoadingStates();
      if (!state.initialLoaded) {
        state.initialLoaded = true;
        applyDeepLink();
      }
    } catch {
      if (!state.catalog) showError();
      hideLoadingStates(true);
    }
  }

  function applySettings() {
    const s = state.catalog?.settings || {};
    if (s.brand) document.title = `${s.brand} — Community Goods`;

    if (s.hero_badge != null) $('heroBadge').textContent = s.hero_badge || 'OFFICIAL COMMUNITY MERCH';
    renderHeroTitle(s.hero_title || 'НЕ ПРОСТО ОДЕЖДА.');
    if (s.hero_subtitle != null) $('heroSubtitle').textContent = s.hero_subtitle;

    const notice = $('notice');
    if (s.notice_text) { notice.textContent = s.notice_text; notice.hidden = false; }
    else notice.hidden = true;

    if (s.footer_text) $('footerText').textContent = s.footer_text;

    const url = String(s.contact_url || '').trim();
    const valid = /^https?:\/\//i.test(url) || /^tg:\/\//i.test(url);
    for (const id of ['contactLink', 'heroContact']) {
      const node = $(id);
      if (valid) { node.href = url; node.hidden = false; }
      else node.hidden = true;
    }
  }

  function renderHeroTitle(raw) {
    const node = $('heroTitle');
    node.textContent = '';
    const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) lines.push('DVIZH FREIBURG');
    lines.forEach((line, li) => {
      if (li > 0) node.append(document.createElement('br'));
      const words = line.split(/\s+/);
      words.forEach((word, wi) => {
        const isLast = li === lines.length - 1 && wi === words.length - 1;
        node.append(isLast ? el('span', { text: word }) : document.createTextNode(word));
        if (wi < words.length - 1) node.append(document.createTextNode(' '));
      });
    });
  }

  function renderBanners() {
    const wrap = $('banners');
    wrap.textContent = '';
    const banners = state.catalog?.banners || [];
    if (!banners.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    for (const b of banners) {
      const hasLink = /^https?:\/\//i.test(String(b.link || ''));
      const card = el(hasLink ? 'a' : 'div', {
        class: 'banner',
        ...(hasLink ? { href: b.link, target: '_blank', rel: 'noopener' } : {}),
      });
      if (b.image) {
        const img = el('img', { src: b.image, alt: b.title || 'Анонс', loading: 'lazy' });
        img.addEventListener('error', () => img.remove(), { once: true });
        card.append(img);
      }
      card.append(
        el('span', { class: 'banner-arrow', 'aria-hidden': 'true', text: hasLink ? '↗' : '✳' }),
        el('div', { class: 'banner-body' },
          b.title ? el('h3', { text: b.title }) : null,
          b.subtitle ? el('p', { text: b.subtitle }) : null,
        ),
      );
      wrap.append(card);
    }
  }

  function renderFilters() {
    const wrap = $('filters');
    wrap.textContent = '';
    const products = state.catalog?.products || [];
    const counts = new Map();
    for (const p of products) counts.set(p.collection, (counts.get(p.collection) || 0) + 1);

    const items = [{ id: 'all', name: 'Все' }];
    for (const c of state.catalog?.collections || []) {
      if ((counts.get(c.id) || 0) > 0) items.push({ id: c.id, name: c.name });
    }
    for (const item of items) {
      const active = String(state.filter) === String(item.id);
      wrap.append(el('button', {
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        dataset: { filter: String(item.id) },
        text: item.name,
      }));
    }
    if (state.filter !== 'all' && !items.some((i) => String(i.id) === String(state.filter))) {
      state.filter = 'all';
      renderFilters();
    }
  }

  function visibleProducts() {
    const products = state.catalog?.products || [];
    const q = state.search.trim().toLowerCase();
    return products.filter((p) => {
      if (state.filter !== 'all' && p.collection !== Number(state.filter)) return false;
      if (!q) return true;
      return `${p.name} ${p.description} ${p.collectionName}`.toLowerCase().includes(q);
    });
  }

  function renderProducts() {
    const grid = $('products');
    grid.textContent = '';
    grid.setAttribute('aria-busy', 'false');
    const list = visibleProducts();
    const all = state.catalog?.products || [];

    $('emptyState').hidden = true;
    $('errorState').hidden = true;
    grid.hidden = false;

    if (!list.length) {
      grid.hidden = true;
      const empty = $('emptyState');
      empty.hidden = false;
      $('emptyText').textContent = all.length
        ? 'По этому фильтру ничего нет. Попробуй другой запрос или коллекцию.'
        : 'Товары скоро появятся. Загляни позже.';
      $('resetFilters').hidden = !all.length;
      updateCatalogMeta(0, all.length);
      return;
    }

    list.forEach((product, index) => {
      grid.append(productCard(product, index));
    });

    updateCatalogMeta(list.length, all.length);
  }

  function updateCatalogMeta(shown, total) {
    const meta = $('catalogMeta');
    if (!total) { meta.textContent = 'DVIZH FREIBURG'; return; }
    const parts = [`${total} ${plural(total, ['позиция', 'позиции', 'позиций'])}`];
    if (shown !== total) parts.push(`показано ${shown}`);
    if (state.filter !== 'all') {
      const c = (state.catalog?.collections || []).find((x) => x.id === Number(state.filter));
      if (c) parts.push(c.name);
    }
    meta.textContent = parts.join(' · ');
  }

  function productCard(product, index) {
    const soldOut = product.stock <= 0;
    const discount = discountPercent(product.price, product.oldPrice);

    const media = el('div', { class: 'card-media' });
    if (product.photos.length) media.append(productImage(product, product.photos[0], product.name));
    else media.append(artEl(product));

    if (soldOut) {
      media.append(el('span', { class: 'card-tag sold', text: 'SOLD OUT' }));
    } else if (discount) {
      media.append(el('span', { class: 'card-tag', text: `−${discount}%` }));
    } else if (product.stock <= 3) {
      media.append(el('span', { class: 'card-tag low', text: `ПОСЛЕДНИЕ ${product.stock}` }));
    }
    media.append(el('span', { class: 'card-cta', text: soldOut ? 'ПОДРОБНЕЕ' : 'ВЫБРАТЬ' }));

    const price = el('span', { class: 'card-price' },
      fmtMoney(product.price),
      product.oldPrice > product.price ? el('s', { text: fmtMoney(product.oldPrice) }) : null,
    );

    const sizeLabel = product.sizes.length
      ? (product.sizes.length > 3 ? `${product.sizes.slice(0, 3).join(' · ')}…` : product.sizes.join(' · '))
      : 'ONE SIZE';

    const card = el('article', {
      class: 'card',
      tabindex: '0',
      role: 'button',
      'aria-label': `${product.name} — ${fmtMoney(product.price)}. Открыть товар`,
      style: `animation-delay:${Math.min(index * 35, 280)}ms`,
    },
      media,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-top' },
          el('h3', { class: 'card-title', text: product.name }),
          price,
        ),
        el('p', { class: 'card-desc', text: product.description || 'Мерч DVIZH FREIBURG. Community goods.' }),
        el('div', { class: 'card-meta' },
          el('span', { class: 'card-meta-collection', text: product.collectionName || 'DVIZH FREIBURG' }),
          el('span', { class: 'card-meta-size', text: soldOut ? 'НЕТ В НАЛИЧИИ' : sizeLabel }),
        ),
      ),
    );

    const open = () => openProduct(product);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return card;
  }

  function showSkeletons() {
    const grid = $('products');
    grid.hidden = false;
    grid.setAttribute('aria-busy', 'true');
    grid.textContent = '';
    $('emptyState').hidden = true;
    $('errorState').hidden = true;
    for (let i = 0; i < 8; i++) {
      grid.append(el('div', { class: 'skeleton', 'aria-hidden': 'true' },
        el('div', { class: 'sk-media' }),
        el('div', { class: 'sk-line' }),
        el('div', { class: 'sk-line short' }),
      ));
    }
    $('catalogMeta').textContent = 'Загрузка…';
  }

  function hideLoadingStates(force = false) {
    $('products').setAttribute('aria-busy', 'false');
    if (force) {
      $('products').hidden = true;
      $('emptyState').hidden = true;
    }
  }

  function showError() {
    $('products').hidden = true;
    $('products').setAttribute('aria-busy', 'false');
    $('emptyState').hidden = true;
    $('errorState').hidden = false;
    $('catalogMeta').textContent = 'Ошибка загрузки';
  }

  // Ссылки вида /?collection=slug и /?product=12 (можно делиться в Telegram).
  function applyDeepLink() {
    const params = new URLSearchParams(location.search);
    const slug = params.get('collection');
    if (slug) {
      const collection = (state.catalog?.collections || []).find((c) => c.slug === slug);
      if (collection) {
        state.filter = collection.id;
        renderFilters();
        renderProducts();
      }
    }
    const id = Number(params.get('product'));
    if (id) {
      const product = findProduct(id);
      if (product) openProduct(product);
    }
  }

  /* ---------------- product modal ---------------- */
  function openProduct(product) {
    state.product = product;
    state.photo = 0;
    state.qty = 1;
    state.size = product.sizes.length
      ? (product.sizes.includes('M') ? 'M' : product.sizes[0])
      : '';
    state.color = product.colors[0] || '';

    $('productKicker').textContent = product.collectionName || 'DVIZH FREIBURG';

    const priceNode = $('productPrice');
    priceNode.textContent = '';
    priceNode.append(el('span', { text: fmtMoney(product.price) }));
    const discount = discountPercent(product.price, product.oldPrice);
    if (product.oldPrice > product.price) priceNode.append(el('s', { text: fmtMoney(product.oldPrice) }));
    if (discount) priceNode.append(el('span', { class: 'discount', text: `−${discount}%` }));

    $('productDesc').textContent = product.description || 'Мерч DVIZH FREIBURG.';

    const sizePick = $('sizePick');
    sizePick.classList.toggle('hidden', !product.sizes.length);
    $('sizes').textContent = '';
    for (const s of product.sizes) {
      $('sizes').append(el('button', {
        type: 'button', class: 'choice', 'aria-pressed': s === state.size ? 'true' : 'false',
        dataset: { size: s }, text: s,
      }));
    }
    $('sizeValue').textContent = state.size;

    const colorPick = $('colorPick');
    colorPick.classList.toggle('hidden', !product.colors.length);
    $('colors').textContent = '';
    for (const c of product.colors) {
      $('colors').append(el('button', {
        type: 'button', class: 'choice', 'aria-pressed': c === state.color ? 'true' : 'false',
        dataset: { color: c }, text: c,
      }));
    }
    $('colorValue').textContent = state.color;

    const stock = $('productStock');
    stock.textContent = '';
    stock.className = 'stock-line';
    if (product.stock <= 0) {
      stock.classList.add('out');
      stock.append(el('span', { class: 'dot' }), el('span', { text: 'Нет в наличии — загляни позже' }));
    } else if (product.stock <= 3) {
      stock.classList.add('low');
      stock.append(el('span', { class: 'dot' }), el('span', {}, 'Осталось всего ', el('b', { text: product.stock }), ' шт.'));
    } else {
      stock.append(el('span', { class: 'dot' }), el('span', {}, 'В наличии: ', el('b', { text: product.stock }), ' шт.'));
    }

    const addBtn = $('addToCart');
    addBtn.disabled = product.stock <= 0;
    addBtn.textContent = product.stock <= 0 ? 'НЕТ В НАЛИЧИИ' : 'ДОБАВИТЬ В КОРЗИНУ';

    renderGallery(product);
    updateQty();

    $('productTitle').textContent = product.name;
    openOverlay('productOverlay', '#addToCart');
  }

  function renderGallery(product) {
    const main = $('galleryMain');
    const thumbs = $('galleryThumbs');
    main.textContent = '';
    thumbs.textContent = '';

    if (!product.photos.length) {
      main.append(artEl(product));
      thumbs.hidden = true;
      return;
    }
    thumbs.hidden = product.photos.length < 2;
    const index = Math.min(state.photo, product.photos.length - 1);
    main.append(productImage(product, product.photos[index], product.name, false));
    if (!thumbs.hidden) {
      product.photos.forEach((src, i) => {
        const btn = el('button', {
          type: 'button',
          'aria-label': `Фото ${i + 1}`,
          'aria-pressed': i === index ? 'true' : 'false',
        }, productImage(product, src, `${product.name} — фото ${i + 1}`));
        btn.addEventListener('click', () => { state.photo = i; renderGallery(product); });
        thumbs.append(btn);
      });
    }
  }

  function updateQty() {
    const max = state.product ? Math.max(1, state.product.stock) : 1;
    state.qty = Math.max(1, Math.min(state.qty, max));
    $('qtyValue').textContent = state.qty;
    $('qtyMinus').disabled = state.qty <= 1;
    $('qtyPlus').disabled = !state.product || state.qty >= max;
  }

  /* ---------------- cart modal ---------------- */
  function updateCartCount() {
    const n = cartCount();
    $('cartCount').textContent = n;
    $('openCart').setAttribute('aria-label', `Открыть корзину, товаров: ${n}`);
  }

  function renderCart() {
    renderCartItems();
    renderCartFoot();
    updateCartCount();
  }

  function cartThumb(product) {
    const wrap = el('div', { class: 'cart-thumb' });
    if (product.photos.length) wrap.append(productImage(product, product.photos[0], product.name));
    else wrap.append(artEl(product));
    return wrap;
  }

  function renderCartItems() {
    const wrap = $('cartItems');
    wrap.textContent = '';
    if (!state.cart.length) {
      wrap.append(el('div', { class: 'cart-empty' },
        el('div', { class: 'state-mark', text: '✳' }),
        el('p', { text: 'Корзина пока пустая.' }),
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { closeOverlay('cartOverlay'); scrollToCatalog(); },
        }, 'ПЕРЕЙТИ В КАТАЛОГ'),
      ));
      return;
    }
    state.cart.forEach((item, index) => {
      const product = findProduct(item.productId);
      if (!product) return;
      const qty = el('div', { class: 'qty' },
        el('button', { type: 'button', 'aria-label': 'Меньше', onclick: () => setQty(index, -1) }, '−'),
        el('b', { text: item.qty }),
        el('button', { type: 'button', 'aria-label': 'Больше', onclick: () => setQty(index, 1) }, '+'),
      );
      wrap.append(el('div', { class: 'cart-row' },
        cartThumb(product),
        el('div', {},
          el('p', { class: 'cart-name', text: product.name }),
          el('div', { class: 'cart-variant', text: [item.size, item.color].filter(Boolean).join(' · ') || 'ONE SIZE' }),
          el('div', { class: 'cart-price', text: `${fmtMoney(product.price)} × ${item.qty}` }),
        ),
        el('div', { class: 'cart-side' },
          qty,
          el('button', {
            class: 'cart-remove', type: 'button',
            onclick: () => { state.cart.splice(index, 1); saveCart(); renderCart(); toast('Удалено из корзины'); },
          }, 'удалить'),
        ),
      ));
    });
  }

  function renderCartFoot() {
    const foot = $('cartFoot');
    foot.textContent = '';
    if (!state.cart.length) return;
    foot.append(
      el('div', { class: 'cart-total' }, el('span', { text: 'Итого' }), el('b', { text: fmtMoney(cartTotal()) })),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: openCheckout }, 'ОФОРМИТЬ ЗАЯВКУ'),
      el('p', { class: 'micro', text: 'Без онлайн-оплаты. Администратор подтвердит наличие и детали заказа.' }),
    );
  }

  function scrollToCatalog() {
    const target = $('catalog');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- checkout ---------------- */
  function openCheckout() {
    if (!state.cart.length) { toast('Корзина пустая'); return; }
    closeOverlay('cartOverlay', { silent: true });
    renderCheckoutSummary();
    $('formError').hidden = true;
    $('customerName').classList.remove('invalid');
    openOverlay('checkoutOverlay', '#customerName');
  }

  function renderCheckoutSummary() {
    const wrap = $('checkoutSummary');
    wrap.textContent = '';
    for (const item of state.cart) {
      const product = findProduct(item.productId);
      if (!product) continue;
      wrap.append(el('div', { class: 'row' },
        el('span', {}, el('b', { text: product.name }), ` · ${[item.size, item.color].filter(Boolean).join(' / ') || 'ONE SIZE'} × ${item.qty}`),
        el('span', { text: fmtMoney(product.price * item.qty) }),
      ));
    }
    wrap.append(el('div', { class: 'sum' },
      el('span', { text: 'Итого' }),
      el('span', { text: fmtMoney(cartTotal()) }),
    ));
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (state.sending) return;
    const name = $('customerName').value.trim();
    const contact = $('customerContact').value.trim();
    const note = $('customerNote').value.trim();
    const errorBox = $('formError');

    $('customerName').classList.remove('invalid');
    errorBox.hidden = true;

    if (name.length < 2) {
      $('customerName').classList.add('invalid');
      errorBox.textContent = 'Напиши, как тебя зовут (минимум 2 символа).';
      errorBox.hidden = false;
      $('customerName').focus();
      return;
    }
    if (!state.cart.length) {
      errorBox.textContent = 'Корзина пустая — добавь товар заново.';
      errorBox.hidden = false;
      return;
    }

    state.sending = true;
    const btn = $('sendOrder');
    const btnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'ОТПРАВЛЯЕМ…';

    try {
      const delivery = document.querySelector('input[name="delivery"]:checked')?.value || 'delivery';
      const idempotencyKey = idempotencyKeyForCart();
      state.idempotencyKey = idempotencyKey;
      const res = await fetch(apiUrl('/api/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          customer_name: name,
          contact,
          note,
          delivery,
          idempotency_key: idempotencyKey,
          items: state.cart.map((i) => ({ productId: i.productId, size: i.size, color: i.color, qty: i.qty })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось отправить заявку');

      const publicId = data.order?.public_id || '';
      const total = data.order?.total ?? cartTotal();

      state.cart = [];
      saveCart();
      resetOrderKey();
      renderCart();
      $('checkoutForm').reset();
      closeOverlay('checkoutOverlay', { silent: true });

      $('successId').textContent = publicId ? `ЗАКАЗ ${publicId} · ${fmtMoney(total)}` : fmtMoney(total);
      $('successText').textContent = 'Администратор получил заявку и свяжется с тобой, чтобы подтвердить наличие, доставку и оплату.';
      const botLink = $('successBot');
      const botHint = $('successHint');
      const botUsername = String(state.catalog?.settings?.bot_username || '').replace(/^@/, '');
      if (botLink && botHint) {
        if (botUsername && publicId) {
          botLink.href = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(publicId)}`;
          botLink.hidden = false;
          botHint.hidden = false;
        } else {
          botLink.hidden = true;
          botHint.hidden = true;
        }
      }
      openOverlay('successOverlay', '#successClose');

      // обновляем остатки на сайте
      loadCatalog({ silent: true });
    } catch (e) {
      errorBox.textContent = e.message || 'Ошибка отправки. Попробуй ещё раз.';
      errorBox.hidden = false;
    } finally {
      state.sending = false;
      btn.disabled = false;
      btn.textContent = btnText;
    }
  }

  /* ---------------- overlays ---------------- */
  function openOverlay(id, focusSelector) {
    const node = $(id);
    if (!node) return;
    if (!overlays.length) lastFocus = document.activeElement;
    node.hidden = false;
    overlays.push(id);
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => {
      const target = focusSelector ? node.querySelector(focusSelector) : null;
      (target || node.querySelector('button, input, [tabindex]') || node).focus?.();
    });
  }

  function closeOverlay(id, { silent = false } = {}) {
    const node = $(id);
    if (!node || node.hidden) return;
    node.hidden = true;
    const index = overlays.lastIndexOf(id);
    if (index >= 0) overlays.splice(index, 1);
    if (!overlays.length) {
      document.body.classList.remove('no-scroll');
      if (!silent && lastFocus && document.contains(lastFocus)) {
        try { lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
      if (id === 'productOverlay') state.product = null;
    }
  }

  function closeTopOverlay() {
    if (!overlays.length) return;
    closeOverlay(overlays[overlays.length - 1]);
  }

  function trapFocus(e) {
    if (e.key !== 'Tab' || !overlays.length) return;
    const node = $(overlays[overlays.length - 1]);
    const focusables = [...node.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((n) => n.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    $('openCart').addEventListener('click', () => { renderCart(); openOverlay('cartOverlay', '#cartOverlay'); });
    $('heroCta').addEventListener('click', scrollToCatalog);
    $('retryBtn').addEventListener('click', () => loadCatalog());
    $('resetFilters').addEventListener('click', () => {
      state.filter = 'all';
      state.search = '';
      $('searchInput').value = '';
      renderFilters();
      renderProducts();
    });

    $('filters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      const value = btn.dataset.filter;
      state.filter = value === 'all' ? 'all' : Number(value);
      renderFilters();
      renderProducts();
    });

    let searchTimer = null;
    $('searchInput').addEventListener('input', (e) => {
      const value = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = value;
        renderProducts();
      }, 130);
    });

    $('sizes').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-size]');
      if (!btn) return;
      state.size = btn.dataset.size;
      for (const b of $('sizes').children) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      $('sizeValue').textContent = state.size;
    });

    $('colors').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      state.color = btn.dataset.color;
      for (const b of $('colors').children) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      $('colorValue').textContent = state.color;
    });

    $('qtyMinus').addEventListener('click', () => { state.qty -= 1; updateQty(); });
    $('qtyPlus').addEventListener('click', () => { state.qty += 1; updateQty(); });

    $('addToCart').addEventListener('click', () => {
      if (!state.product) return;
      addToCart(state.product, state.size, state.color, state.qty);
      closeOverlay('productOverlay');
      openOverlay('cartOverlay', '#cartOverlay');
    });

    $('checkoutForm').addEventListener('submit', submitOrder);

    $('successClose').addEventListener('click', () => closeOverlay('successOverlay'));

    document.addEventListener('click', (e) => {
      const closer = e.target.closest('[data-close]');
      if (closer) { closeOverlay(closer.dataset.close); return; }
      if (e.target.classList && e.target.classList.contains('overlay')) {
        closeOverlay(e.target.id);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopOverlay();
      else trapFocus(e);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.catalog) loadCatalog({ silent: true });
    });
  }

  /* ---------------- init ---------------- */
  function init() {
    state.cart = loadCart();
    updateCartCount();
    bindEvents();
    loadCatalog();
    setInterval(() => {
      if (document.visibilityState === 'visible' && !overlays.length && state.catalog) {
        loadCatalog({ silent: true });
      }
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
