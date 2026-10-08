// Official agent logos (from brand-svgs.js, Lobe Icons MIT) and the Stormo logo.
import { icon } from './dom.js';
import { BRAND_SVGS } from './brand-svgs.js';

export const ENGINE_NAMES = {
  claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', gemini: 'Gemini CLI',
  grok: 'Grok Build', glm: 'GLM (z.ai)', copilot: 'GitHub Copilot', cursor: 'Cursor Agent', terminal: 'Terminal',
};

// Short name for the composer's chips ("Claude", "Codex"…).
export const ENGINE_SHORT = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', gemini: 'Gemini' };

// Gradients and masks for colored logos go into the global <defs> (#fm-defs) only ONCE:
// that way they still work when another copy of the logo is hidden (display:none).
const bodies = {};
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const defs = document.querySelector('#fm-defs defs');
  const NON_RENDERING = /^(mask|lineargradient|radialgradient|clippath|filter|pattern|symbol)$/i;
  for (const [key, svg] of Object.entries(BRAND_SVGS)) {
    const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" ${svg.attrs}>${svg.body}</svg>`, 'image/svg+xml');
    const root = doc.documentElement;
    for (const el of [...root.querySelectorAll('[id]')]) {
      if (NON_RENDERING.test(el.localName) && defs) {
        defs.appendChild(document.importNode(el, true));
        el.remove();
      }
    }
    root.querySelectorAll('defs').forEach((d) => { if (!d.children.length) d.remove(); });
    bodies[key] = { attrs: svg.attrs, inner: new XMLSerializer().serializeToString(root).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '') };
  }
}

export function mark(id, cls = 'mark') {
  install();
  const b = bodies[id];
  if (!b) return icon('square-terminal', cls);
  return `<svg class="${cls}" viewBox="0 0 24 24" ${b.attrs} aria-hidden="true" style="color:var(--ink)">${b.inner}</svg>`;
}

// App logo: the same image as the icon (generated with Codex image_gen, edges cleaned up).
export function brandMark(cls = 'brand-mark') {
  return `<img class="${cls}" src="app://stormo/assets/brand-64.png" alt="" draggable="false">`;
}
