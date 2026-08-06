/**
 * components.js — DOM helpers and small shared widgets.
 *
 * No framework. The application state is small, the update surface is a
 * handful of views, and a full re-render of one view on change is fast enough
 * that reconciliation would be complexity without a payoff.
 *
 * @module ui/components
 */

/** Escape for interpolation into innerHTML. Every user string goes through it. */
export function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Create an element. `attrs.class`, `attrs.html`, `attrs.text`, `on*` handlers
 * and `dataset` are all understood.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Replace a container's contents with an HTML string. */
export function render(container, html) {
  container.innerHTML = html;
  return container;
}

/**
 * Event delegation. One listener per container rather than one per row, so a
 * re-render cannot leak handlers.
 */
export function delegate(root, eventName, selector, handler) {
  root.addEventListener(eventName, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

/* ============================================================
   SHARED MARKUP
   ============================================================ */

/**
 * A labelled statistic.
 * @param {{label:string, value:string, sub?:string, tone?:'good'|'bad'|'neutral', hint?:string}} opts
 */
export function statTile({ label, value, sub, tone = 'neutral', hint }) {
  return `
    <div class="stat stat--${tone}"${hint ? ` title="${esc(hint)}"` : ''}>
      <div class="stat__label">${esc(label)}</div>
      <div class="stat__value num">${value}</div>
      ${sub ? `<div class="stat__sub">${sub}</div>` : ''}
    </div>`;
}

export function card({ title, subtitle, body, footer, accent = false, id }) {
  return `
    <section class="card${accent ? ' card--accent' : ''}"${id ? ` id="${esc(id)}"` : ''}>
      ${title ? `<header class="card__head">
        <h2 class="card__title">${esc(title)}</h2>
        ${subtitle ? `<p class="card__sub">${subtitle}</p>` : ''}
      </header>` : ''}
      <div class="card__body">${body}</div>
      ${footer ? `<footer class="card__foot">${footer}</footer>` : ''}
    </section>`;
}

/** Confidence pill — level is one of high/moderate/low/veryLow. */
export function confidencePill(confidence) {
  if (!confidence) return '';
  return `<span class="pill pill--${esc(confidence.level)}">${esc(confidence.label)} confidence</span>`;
}

/**
 * A disclosure block for the long-form explanations. Collapsed by default:
 * the reasoning should be available on demand, not shouted at every glance.
 */
export function detail(summary, body) {
  return `
    <details class="detail">
      <summary>${esc(summary)}</summary>
      <div class="detail__body">${body}</div>
    </details>`;
}

export function note(text, level = 'info') {
  return `<p class="note note--${esc(level)}">${text}</p>`;
}

/** Horizontal proportion bar for the expenditure breakdown. */
export function segmentBar(segments, total) {
  const sum = total || segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const parts = segments
    .map((s) => {
      const pct = (Math.max(0, s.value) / sum) * 100;
      if (pct <= 0) return '';
      return `<span class="segbar__seg segbar__seg--${esc(s.id)}" style="width:${pct.toFixed(2)}%" title="${esc(s.label)}: ${Math.round(s.value)} kcal"></span>`;
    })
    .join('');
  const legend = segments
    .map(
      (s) => `<li><i class="dot dot--${esc(s.id)}"></i>${esc(s.label)}
        <b class="num">${Math.round(s.value).toLocaleString()}</b>
        <span class="muted num">${((Math.max(0, s.value) / sum) * 100).toFixed(0)}%</span></li>`,
    )
    .join('');
  return `<div class="segbar">${parts}</div><ul class="segbar__legend">${legend}</ul>`;
}

/* ============================================================
   FORM FIELDS
   ============================================================ */

export function field({ label, name, value, type = 'number', step, min, max, placeholder, suffix, hint, inputmode }) {
  const v = value == null ? '' : value;
  return `
    <label class="field">
      <span class="field__label">${esc(label)}${hint ? `<i class="field__hint" title="${esc(hint)}">?</i>` : ''}</span>
      <span class="field__input">
        <input
          type="${esc(type)}"
          name="${esc(name)}"
          value="${esc(v)}"
          ${step != null ? `step="${esc(step)}"` : ''}
          ${min != null ? `min="${esc(min)}"` : ''}
          ${max != null ? `max="${esc(max)}"` : ''}
          ${inputmode ? `inputmode="${esc(inputmode)}"` : type === 'number' ? 'inputmode="decimal"' : ''}
          ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
          autocomplete="off" />
        ${suffix ? `<span class="field__suffix">${esc(suffix)}</span>` : ''}
      </span>
    </label>`;
}

export function selectField({ label, name, value, options, hint }) {
  const opts = options
    .map((o) => {
      if (o.group) {
        const inner = o.items
          .map((i) => `<option value="${esc(i.value)}"${i.value === value ? ' selected' : ''}>${esc(i.label)}</option>`)
          .join('');
        return `<optgroup label="${esc(o.group)}">${inner}</optgroup>`;
      }
      return `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`;
    })
    .join('');
  return `
    <label class="field">
      <span class="field__label">${esc(label)}${hint ? `<i class="field__hint" title="${esc(hint)}">?</i>` : ''}</span>
      <span class="field__input">
        <select name="${esc(name)}">${opts}</select>
      </span>
    </label>`;
}

export function toggleField({ label, name, checked, hint }) {
  return `
    <label class="toggle">
      <input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''} />
      <span class="toggle__track"><span class="toggle__thumb"></span></span>
      <span class="toggle__label">${esc(label)}${hint ? `<i class="field__hint" title="${esc(hint)}">?</i>` : ''}</span>
    </label>`;
}

export function textareaField({ label, name, value, placeholder, rows = 3 }) {
  return `
    <label class="field field--wide">
      <span class="field__label">${esc(label)}</span>
      <textarea name="${esc(name)}" rows="${rows}" placeholder="${esc(placeholder || '')}">${esc(value || '')}</textarea>
    </label>`;
}

/** Segmented control — used for rating scales and short option sets. */
export function segmented({ label, name, value, options }) {
  const buttons = options
    .map(
      (o) => `<button type="button" class="seg${String(o.value) === String(value) ? ' is-active' : ''}"
        data-seg="${esc(name)}" data-value="${esc(o.value)}">${esc(o.label)}</button>`,
    )
    .join('');
  return `
    <div class="field">
      <span class="field__label">${esc(label)}</span>
      <div class="segmented" data-segmented="${esc(name)}">${buttons}</div>
    </div>`;
}

/* ============================================================
   TRANSIENT UI
   ============================================================ */

let toastTimer = null;

export function toast(message, tone = 'info') {
  let host = qs('#toast');
  if (!host) {
    host = el('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(host);
  }
  host.className = `toast toast--${tone} is-visible`;
  host.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('is-visible'), 3200);
}

/** Native confirm, isolated here so it can be swapped for a styled dialog. */
export function confirmAction(message) {
  return window.confirm(message);
}

/**
 * Read a form into a plain object, converting empty strings to null so the
 * schema layer sees "absent" rather than "".
 */
export function readForm(form) {
  const out = {};
  for (const input of form.querySelectorAll('input, select, textarea')) {
    if (!input.name) continue;
    if (input.type === 'checkbox') {
      out[input.name] = input.checked;
    } else if (input.type === 'number') {
      out[input.name] = input.value === '' ? null : Number(input.value);
    } else {
      out[input.name] = input.value === '' ? null : input.value;
    }
  }
  return out;
}
