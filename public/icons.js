/**
 * Rough gear icons — placeholders until there are real photos, and the
 * fallback gearVisual() below still reaches for whenever an item doesn't
 * have one.
 *
 * Line drawings on `currentColor`, so they pick up the status colour of the
 * row they sit in and need no asset pipeline. Chosen by category first, then
 * overridden by name where a category is too coarse to be useful: "Support"
 * covers a tripod, a gimbal and a slider, and those look nothing alike on a
 * shelf.
 */

const svg = body =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const ICONS = {
  camera: svg(`<rect x="2.2" y="7.5" width="12.6" height="9.5" rx="1.6"/>
    <circle cx="8.5" cy="12.2" r="2.7"/>
    <path d="M14.8 10.6l6.4-2.4v7.9l-6.4-2.4z"/>
    <path d="M5.4 7.5V6h4.2v1.5"/>`),

  lens: svg(`<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.9"/>
    <path d="M12 3.6v2.1M12 18.3v2.1M3.6 12h2.1M18.3 12h2.1"/>`),

  lighting: svg(`<circle cx="12" cy="9.6" r="4.4"/>
    <path d="M12 1.9v2.1M5.1 4.3l1.5 1.5M2.4 9.6h2.1M18.9 4.3l-1.5 1.5M19.5 9.6h2.1"/>
    <path d="M9.6 16.7h4.8M10.3 19.9h3.4"/>`),

  tube: svg(`<rect x="9.4" y="2.2" width="5.2" height="19.6" rx="2.6"/>
    <path d="M12 5.6v12.8"/><path d="M4.6 8.4h2.2M4.6 15.6h2.2M17.2 8.4h2.2M17.2 15.6h2.2"/>`),

  audio: svg(`<rect x="9" y="2.4" width="6" height="11.2" rx="3"/>
    <path d="M5.4 11.1a6.6 6.6 0 0013.2 0"/><path d="M12 17.7v3.6M9.2 21.3h5.6"/>`),

  boom: svg(`<path d="M3.4 20.6L17 7"/><path d="M13.4 3.4l4.3 4.3-2.4 2.4-4.3-4.3z"/>
    <path d="M6.6 13.4l4 4"/><path d="M3.4 20.6l1.6-4.2"/>`),

  recorder: svg(`<rect x="2.4" y="5.4" width="19.2" height="13.2" rx="1.8"/>
    <circle cx="7.6" cy="12" r="2.2"/><circle cx="14.2" cy="12" r="2.2"/>
    <path d="M18.4 9.6v4.8"/>`),

  tripod: svg(`<rect x="8.6" y="2.2" width="6.8" height="2.6" rx="0.9"/>
    <path d="M12 4.8v7.6"/><path d="M12 12.4L6.2 21M12 12.4L17.8 21M12 12.4V21"/>
    <path d="M8.4 17.2h7.2"/>`),

  gimbal: svg(`<path d="M6.4 4.2v7.4a5.6 5.6 0 0011.2 0V4.2"/>
    <rect x="8.8" y="7.6" width="6.4" height="5" rx="1.2"/>
    <path d="M12 17.2v4.2M9 21.4h6"/>`),

  slider: svg(`<rect x="2.2" y="13.4" width="19.6" height="3.2" rx="1.2"/>
    <rect x="8.4" y="7.6" width="7.2" height="5.8" rx="1.2"/>
    <path d="M4.6 16.6v3.2M19.4 16.6v3.2"/>`),

  grip: svg(`<path d="M4.6 21.4h14.8"/><path d="M12 21.4V6.4"/>
    <path d="M12 10.2l6.2-3.1M12 14.2L5.8 11.1"/><circle cx="12" cy="4.4" r="2.2"/>`),

  power: svg(`<rect x="2.4" y="6.8" width="16.2" height="10.4" rx="2"/>
    <path d="M21.6 10.4v3.2"/><path d="M6 10v4M9.6 10v4M13.2 10v4"/>`),

  monitor: svg(`<rect x="2.4" y="4" width="19.2" height="12.6" rx="1.6"/>
    <path d="M9 20.4h6M12 16.6v3.8"/>`),

  laptop: svg(`<rect x="3.4" y="5" width="17.2" height="11.4" rx="1.5"/>
    <path d="M1.6 19.4h20.8"/><path d="M10 16.4h4"/>`),

  diffusion: svg(`<rect x="3" y="3.4" width="18" height="17.2" rx="1.4"/>
    <path d="M3 9.1h18M3 14.9h18"/><path d="M9.1 3.4v17.2M14.9 3.4v17.2"/>`),

  case: svg(`<rect x="2.8" y="6.6" width="18.4" height="12.2" rx="1.6"/>
    <path d="M8.2 6.6V5a1.6 1.6 0 011.6-1.6h4.4A1.6 1.6 0 0115.8 5v1.6"/>
    <path d="M2.8 12.2h18.4"/>`)
};

/* Checked in order, so the most specific wins. Matched against name + model,
   which is where the distinguishing word actually lives. */
const NAME_RULES = [
  [/\bfloppy\b|ultrabounce|diffusion|eggcrate|\bgrid\b|\brag\b|silk|bounce/i, 'diffusion'],
  [/\bipad\b|macbook|laptop|\bimac\b|surface/i, 'laptop'],
  [/gimbal|ronin|stabili[sz]/i,                 'gimbal'],
  [/slider|dolly|\bjib\b|glidecam/i,            'slider'],
  [/tripod|fluid head|\bsticks\b|\bfsb\b|\bhead\b/i, 'tripod'],
  [/monitor|display|smallhd|\bevf\b/i,          'monitor'],
  [/batter|v-?mount|hypercore|charger|\bd-?tap\b/i, 'power'],
  [/\bboom\b|boom pole|\bpole\b/i,              'boom'],
  [/recorder|mixpre|\bmixer\b|zoom h\d/i,       'recorder'],
  [/\btube\b|titan|pavotube|astera/i,           'tube'],
  [/\bmic\b|microphone|\bmkh\b|wireless go|lavalier|\blav\b|shotgun/i, 'audio'],
  [/c-?stand|apple box|sandbag|clamp|\bflag\b|matthews/i, 'grip'],
  [/\blens\b|probe|\bmm\b|f\/?\d|prime|zoom lens/i, 'lens']
];

/* Keyed on the top level of the category path — "Lighting/Diffusion/Bounce"
   resolves on "lighting". Name rules above still override, which is what
   separates a tripod from a gimbal inside "Camera Stabilization". */
const CATEGORY_ICON = {
  camera: 'camera', cameras: 'camera', body: 'camera', bodies: 'camera',
  lens: 'lens', lenses: 'lens', optics: 'lens',
  lighting: 'lighting', light: 'lighting', lights: 'lighting',
  audio: 'audio', sound: 'audio',
  support: 'tripod', rigging: 'tripod',
  'camera stabilization': 'tripod',
  stands: 'grip', stand: 'grip', grip: 'grip',
  power: 'power', batteries: 'power', battery: 'power',
  monitoring: 'monitor', monitor: 'monitor', monitors: 'monitor',
  laptops: 'laptop', laptop: 'laptop', computers: 'laptop',
  accessories: 'case', misc: 'case', uncategorized: 'case'
};

/** Which icon an item gets. Exported so it can be checked without rendering. */
export function iconKeyFor(item = {}) {
  const haystack = `${item.name || ''} ${item.model || ''}`;
  for (const [pattern, key] of NAME_RULES) {
    if (pattern.test(haystack)) return key;
  }
  return CATEGORY_ICON[String(item.category || '').toLowerCase().trim()] || 'case';
}

export function iconFor(item) {
  return ICONS[iconKeyFor(item)] || ICONS.case;
}

/**
 * What every `.gear-i` box should actually render: the real photo when the
 * item has one — either fetched once at import time or uploaded by hand,
 * both served from the API, never hot-linked — falling back to the
 * line-drawing icon otherwise. `has_image` comes from /api/state; the bytes
 * themselves never travel there.
 *
 * `?v=` is a cache-buster, not a real query param the server reads — the
 * image route tells the browser to cache a URL forever, which only stays
 * true if the URL itself changes whenever the photo does. image_v comes from
 * /api/state too, bumped server-side on every upload or removal.
 */
export function gearVisual(item) {
  return item?.has_image
    ? `<img src="/api/items/${item.id}/image?v=${item.image_v || 0}" alt="" loading="lazy">`
    : iconFor(item);
}

/**
 * Same idea as gearVisual, for a kit or package rather than an item — no
 * per-name icon catalogue for those, just one generic case icon when there's
 * no photo.
 */
export function kitVisual(kit) {
  return kit?.has_image
    ? `<img src="/api/kits/${kit.id}/image?v=${kit.image_v || 0}" alt="" loading="lazy">`
    : ICONS.case;
}

/**
 * First letter of up to two words — "Camden Goff" to "CG", a bare email to
 * its first letter. The fallback for a person with no photo, same job
 * gearVisual's line-art icon does for an item.
 */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

export const ICON_KEYS = Object.keys(ICONS);
