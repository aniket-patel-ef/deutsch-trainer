// Tiny DOM helpers. No framework: the whole app is a handful of screens that
// re-render wholesale, and a build step would only get in the way of Pages.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function mount(...nodes) {
  const screen = document.getElementById('screen');
  screen.replaceChildren(...nodes.flat().filter(Boolean));
  screen.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
  return screen;
}

export const spinner = () => el('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });

let toastTimer = null;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: 'toast', role: 'status', text: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}

/** Adds a one-tap umlaut row under a text field — most keyboards bury them. */
export function umlautRow(getInput) {
  return el('div', { class: 'umlauts' },
    ['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'].map((ch) =>
      el('button', {
        type: 'button',
        onclick: () => {
          const input = getInput();
          if (!input) return;
          const at = input.selectionStart ?? input.value.length;
          input.value = input.value.slice(0, at) + ch + input.value.slice(input.selectionEnd ?? at);
          input.selectionStart = input.selectionEnd = at + ch.length;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        },
      }, ch)));
}
