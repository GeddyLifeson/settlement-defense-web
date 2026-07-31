// Real SVG art assets, replacing the earlier Canvas-2D-primitive sprites. Embedded as inline JS
// template strings (NOT separate .svg files) and loaded via data: URIs -- this project's whole
// design point is "double-click index.html, no server," and a fetch() for an external .svg file
// hits the exact file:// CORS wall that already broke ES modules earlier in this project (see
// build.py's header comment). A data: URI Image load has no such restriction.
//
// Recoloring: each template has {{FILL}}-style placeholders substituted before the Image is
// created, so one silhouette can serve many palette variants (citizen roles, attacker
// archetypes, generator kinds, etc.) without needing a separate SVG file per color. Baked
// variants are cached forever in `_cache` keyed by `templateId|substitutions`, so the string
// substitution + Image decode only happens once per distinct combination ever seen.

const _cache = new Map();

function svgDataUri(svgString) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
}

// Returns a cached, possibly-still-loading HTMLImageElement for `templateId` with `vars`
// substituted in. Callers must tolerate `!img.complete` on the first ever draw of a new
// variant (a few frames of "not drawn yet" while the browser decodes the data URI) -- this
// matches how every other async-load pattern in this codebase already degrades (e.g. renderer
// resize self-healing), not a new failure mode.
export function getSprite(templateId, vars = {}) {
  const key = templateId + '|' + Object.entries(vars).sort().map(([k, v]) => `${k}=${v}`).join(',');
  let img = _cache.get(key);
  if (img) return img;

  let svg = TEMPLATES[templateId];
  if (!svg) throw new Error(`assets.js: unknown sprite template "${templateId}"`);
  for (const [k, v] of Object.entries(vars)) {
    svg = svg.split(`{{${k}}}`).join(v);
  }
  img = new Image();
  img.decoding = 'async';
  img.src = svgDataUri(svg);
  _cache.set(key, img);
  return img;
}

// Draws `templateId` centered at (cx, cy) scaled so its longer edge is `size` px, rotated by
// `rotation` radians (0 = "up" i.e. north, matching how the game already treats screen-up as a
// neutral facing). No-ops silently if the sprite hasn't finished decoding yet, matching
// getSprite's documented degrade-gracefully contract.
export function drawSprite(ctx, templateId, vars, cx, cy, size, rotation = 0, alpha = 1) {
  const img = getSprite(templateId, vars);
  if (!img.complete || !img.naturalWidth) return false;
  const ar = img.naturalHeight / img.naturalWidth;
  const w = size, h = size * ar;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy);
  if (rotation) ctx.rotate(rotation);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Templates. viewBox is always "0 0 100 100" with the sprite's visual center at (50,50) so
// drawSprite's centering math is uniform across every template regardless of silhouette shape.
// Palette placeholders use {{UPPER_SNAKE}} names, substituted per-call by drawSprite's `vars`.

const TEMPLATES = {
  // Humanoid torso+head, no legs (legs stay Canvas-drawn in render.js since they're the part
  // that animates every frame via the walk-bob -- baking a walk cycle into a handful of SVG
  // frames was tried and reads worse at this sprite size than the existing procedural bob, so
  // the hybrid split is deliberate: SVG for the silhouette that benefits from real curves and
  // shading, procedural for the part that needs per-frame motion).
  humanoid_torso: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bodyShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{BODY}}" stop-opacity="1"/>
      <stop offset="100%" stop-color="{{BODY_SHADOW}}" stop-opacity="1"/>
    </linearGradient>
    <radialGradient id="headShade" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="{{HEAD_HI}}"/>
      <stop offset="100%" stop-color="{{HEAD}}"/>
    </radialGradient>
  </defs>
  <path d="M 28 92 Q 24 60 32 40 Q 36 28 50 26 Q 64 28 68 40 Q 76 60 72 92 Q 50 100 28 92 Z"
        fill="url(#bodyShade)" stroke="{{OUTLINE}}" stroke-width="3.2" stroke-linejoin="round"/>
  <circle cx="50" cy="24" r="19" fill="url(#headShade)" stroke="{{OUTLINE}}" stroke-width="3.2"/>
  <path d="M 32 16 Q 50 2 68 16 Q 68 10 50 8 Q 32 10 32 16 Z" fill="{{HAIR}}"/>
  <path d="M 32 16 Q 34 26 32 32 Q 27 24 28 18 Q 29 15 32 16 Z" fill="{{HAIR}}"/>
  <path d="M 68 16 Q 66 26 68 32 Q 73 24 72 18 Q 71 15 68 16 Z" fill="{{HAIR}}"/>
</svg>`.trim(),

  // Boss crown, drawn as a separate overlay sprite on top of the boss's humanoid_torso -- kept
  // apart so the plain torso template stays reusable for every non-boss archetype.
  boss_crown: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 30 60 L 34 30 L 44 46 L 50 22 L 56 46 L 66 30 L 70 60 Z"
        fill="{{GOLD}}" stroke="{{OUTLINE}}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="50" cy="22" r="4" fill="{{GEM}}"/>
</svg>`.trim(),

  // Quadruped silhouette (dogs + wild animals share this) -- a rounded body, a raised head, two
  // ears. Collar (tamed dogs only) is a separate thin ring overlay drawn by the caller so the
  // same body art serves both tamed and wild without a second template.
  animal_body: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="coatShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{COAT_HI}}"/>
      <stop offset="100%" stop-color="{{COAT}}"/>
    </linearGradient>
  </defs>
  <ellipse cx="42" cy="58" rx="34" ry="22" fill="url(#coatShade)" stroke="{{OUTLINE}}" stroke-width="3"/>
  <circle cx="76" cy="42" r="17" fill="url(#coatShade)" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 68 30 L 64 16 L 76 26 Z" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M 82 28 L 86 14 L 90 27 Z" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="82" cy="40" r="2.6" fill="{{OUTLINE}}"/>
</svg>`.trim(),
};

export const SPRITE_IDS = Object.keys(TEMPLATES);
