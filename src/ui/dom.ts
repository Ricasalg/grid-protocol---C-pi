/* ============================================================================
   Minimal DOM helpers.

   The UI is plain HTML over the canvas — no framework. These three functions
   cover everything the interface needs, and keeping them here means no module
   ever reaches for innerHTML with interpolation.
   ========================================================================== */

type AttrValue = string | number | boolean | undefined | null;
type Attrs = Record<string, AttrValue | ((ev: never) => void)>;

/**
 * Create an element with attributes and children in one call.
 *
 * A function-valued attribute is treated as an event listener: `onclick`,
 * `oninput` and friends. That keeps call sites declarative without ever
 * building HTML strings, so nothing user-supplied is ever interpolated.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;

    if (typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/** Shorthand for a namespaced SVG element. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;
    if (typeof value === 'function') continue; // no SVG interaction here
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.setAttribute('class', String(value));
    else node.setAttribute(key, String(value));
  }

  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Toggle a class and return the new state. */
export function toggleClass(node: Element, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}