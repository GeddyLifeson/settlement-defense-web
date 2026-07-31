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

  // Wall: deliberately plain -- it's the cheapest, most-placed structure, so a blocky slab with
  // a couple of mortar-line seams reads as "solid barrier" at a glance without adding per-tile
  // visual noise once dozens are placed edge-to-edge.
  wall: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="wallShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="84" height="84" fill="url(#wallShade)" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 8 36 H 92 M 8 64 H 92 M 32 8 V 36 M 68 36 V 64 M 32 64 V 92" stroke="{{OUTLINE}}" stroke-width="3" stroke-opacity="0.5"/>
</svg>`.trim(),

  // Trap: a spring-loaded jaw motif, small and low so it still reads as "hidden hazard" rather
  // than a prominent structure.
  trap: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="trapShade" cx="40%" cy="35%" r="70%">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="32" fill="url(#trapShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 50 22 L 58 44 L 50 50 L 42 44 Z M 78 50 L 56 58 L 50 50 L 56 42 Z
           M 50 78 L 42 56 L 50 50 L 58 56 Z M 22 50 L 44 42 L 50 50 L 44 58 Z"
        fill="{{TEETH}}" stroke="{{OUTLINE}}" stroke-width="2" stroke-linejoin="round"/>
</svg>`.trim(),

  // Turret: a rotating gun housing on a round base -- a distinct round silhouette (vs. the wall's
  // square block) topped by a short barrel so it reads as "this one shoots back."
  turret: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="turretShade" cx="38%" cy="34%" r="70%">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </radialGradient>
  </defs>
  <rect x="12" y="12" width="76" height="76" rx="10" fill="url(#turretShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <circle cx="50" cy="50" r="26" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <rect x="43" y="6" width="14" height="40" rx="4" fill="{{BARREL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <circle cx="50" cy="50" r="10" fill="{{BARREL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Tesla coil: a squat base with an arcing-ring motif above it. The ring can't animate as a
  // static SVG, so the "electricity" read comes from the bright ring color + spark ticks instead
  // of motion.
  tesla: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="teslaBase" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <ellipse cx="50" cy="66" rx="30" ry="22" fill="url(#teslaBase)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="46" y="24" width="8" height="30" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <circle cx="50" cy="26" r="18" fill="none" stroke="{{ARC}}" stroke-width="4"/>
  <path d="M 50 12 L 46 26 L 54 26 L 50 40" fill="none" stroke="{{ARC}}" stroke-width="3" stroke-linejoin="round"/>
</svg>`.trim(),

  // Floodlight: a slim post topped by a lamp housing -- the glow itself stays a separate Canvas
  // radial (drawn by the caller before/after this sprite) since a baked-in glow wouldn't dim
  // correctly when destroyed.
  floodlight: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="44" y="40" width="12" height="52" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 30 40 L 70 40 L 60 22 L 40 22 Z" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="50" cy="30" r="11" fill="{{LAMP}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Armory: fortified small building with the crossed-rifles motif baked directly into the
  // silhouette instead of drawn as a separate overlay.
  armory: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="armoryShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="9" y="12" width="82" height="76" rx="4" fill="url(#armoryShade)" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 30 30 L 70 70 M 30 70 L 70 30" stroke="{{GLYPH}}" stroke-width="6" stroke-linecap="round"/>
</svg>`.trim(),

  // Watchtower: a raised platform on a support post -- kept taller/narrower than the other
  // structure icons so it silhouettes distinctly at a glance even at small map scale.
  watchtower: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="42" y="34" width="16" height="58" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <rect x="12" y="10" width="76" height="30" rx="3" fill="{{PLATFORM}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 12 40 L 22 52 M 88 40 L 78 52" stroke="{{OUTLINE}}" stroke-width="3" stroke-linecap="round"/>
</svg>`.trim(),

  // Bed: frame + pillow silhouette. Headboard reads as a slightly taller/darker band at the top
  // edge so the sprite has an implied "head end" even though beds are drawn top-down with no
  // sleeping-direction logic elsewhere in the sim.
  bed: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bedShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FRAME_HI}}"/>
      <stop offset="100%" stop-color="{{FRAME}}"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="80" height="80" rx="6" fill="url(#bedShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="10" y="10" width="80" height="16" rx="4" fill="{{FRAME}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <rect x="18" y="32" width="64" height="24" rx="5" fill="{{PILLOW}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Table: plain rectangular tabletop with a subtle inset grain line so it doesn't read as a
  // flat solid-color box.
  table: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="tableShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="12" width="84" height="76" rx="5" fill="url(#tableShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="18" y="22" width="64" height="56" rx="3" fill="none" stroke="{{OUTLINE}}" stroke-width="2" stroke-opacity="0.35"/>
</svg>`.trim(),

  // Door: a frame + inset panel + small handle dot -- the "obviously just a colored box" fix.
  // The frame is a darker outer band, the panel a lighter inset rectangle so it silhouettes as
  // an actual door rather than a plain rect even at small map scale.
  door: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="doorShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{PANEL_HI}}"/>
      <stop offset="100%" stop-color="{{PANEL}}"/>
    </linearGradient>
  </defs>
  <rect x="14" y="4" width="72" height="92" rx="3" fill="{{FRAME}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="22" y="12" width="56" height="76" rx="2" fill="url(#doorShade)" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <circle cx="70" cy="50" r="4" fill="{{HANDLE}}" stroke="{{OUTLINE}}" stroke-width="1.6"/>
</svg>`.trim(),

  // Camera: mounting post + angled lens housing, matching the existing primitive's composition
  // (post, rotated housing box, lit lens dot) so the conversion is a faithful redraw rather than
  // a redesign. Lens dot color still comes in via `vars` so destroyed-state tint keeps working.
  camera: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="44" y="46" width="12" height="46" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <g transform="translate(50 34) rotate(-23)">
    <rect x="-30" y="-15" width="52" height="26" rx="3" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3"/>
    <circle cx="20" cy="-2" r="7" fill="{{LENS}}" stroke="{{OUTLINE}}" stroke-width="2"/>
  </g>
</svg>`.trim(),

  // Monitor station: desk + monitor bank, with the two screen tiles colored per-call via `vars`
  // so the staffed/unstaffed/destroyed 3-way state (see render.js's _drawStructureShape) keeps
  // reading correctly -- the SVG itself carries no state, only the substituted screen color does.
  monitor_station: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="deskShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{DESK_HI}}"/>
      <stop offset="100%" stop-color="{{DESK}}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="56" width="84" height="34" rx="3" fill="url(#deskShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="10" y="10" width="80" height="40" rx="3" fill="{{BANK}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="16" y="16" width="32" height="28" rx="2" fill="{{SCREEN}}" stroke="{{OUTLINE}}" stroke-width="2"/>
  <rect x="52" y="16" width="32" height="28" rx="2" fill="{{SCREEN}}" stroke="{{OUTLINE}}" stroke-width="2"/>
</svg>`.trim(),

  // Plain generator: boxy industrial housing (a squared-off cabinet with vent panels) around a
  // glowing core light. The "default" power source silhouette other generator_* variants below
  // deliberately read as heavier/lighter/differently-shaped than.
  generator: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="genHousing" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{HOUSING_HI}}"/>
      <stop offset="100%" stop-color="{{HOUSING}}"/>
    </linearGradient>
    <radialGradient id="genCore" cx="50%" cy="50%" r="65%">
      <stop offset="0%" stop-color="{{CORE_HI}}"/>
      <stop offset="100%" stop-color="{{CORE}}"/>
    </radialGradient>
  </defs>
  <rect x="9" y="9" width="82" height="82" rx="7" fill="url(#genHousing)" stroke="{{OUTLINE}}" stroke-width="3.5"/>
  <rect x="18" y="18" width="64" height="12" fill="{{HOUSING_SHADOW}}" opacity="0.55"/>
  <rect x="18" y="70" width="18" height="10" fill="{{HOUSING_SHADOW}}" opacity="0.4"/>
  <rect x="64" y="70" width="18" height="10" fill="{{HOUSING_SHADOW}}" opacity="0.4"/>
  <circle cx="50" cy="55" r="17" fill="url(#genCore)" stroke="{{OUTLINE}}" stroke-width="2.6"/>
</svg>`.trim(),

  // Nuclear generator: heavier/darker housing than the plain generator, with a radiation-trefoil
  // glyph (three wedges around a hot core) glowing sickly green instead of the plain generator's
  // warm amber -- the same green family as the nuclear hazard radius so the two visually associate.
  generator_nuclear: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="nukeHousing" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{HOUSING_HI}}"/>
      <stop offset="100%" stop-color="{{HOUSING}}"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="92" height="92" rx="5" fill="url(#nukeHousing)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <circle cx="50" cy="50" r="30" fill="{{WELL}}"/>
  <path d="M 50 50 L 41.1 25.6 A 26 26 0 0 1 58.9 25.6 Z" fill="{{CORE}}"/>
  <path d="M 50 50 L 75.6 54.5 A 26 26 0 0 1 66.7 69.9 Z" fill="{{CORE}}"/>
  <path d="M 50 50 L 33.3 69.9 A 26 26 0 0 1 24.4 54.5 Z" fill="{{CORE}}"/>
  <circle cx="50" cy="50" r="8" fill="{{CORE_HI}}"/>
</svg>`.trim(),

  // Coal generator: squatter/dirtier housing than the plain generator, with a coal-pile
  // silhouette out front, a small chimney, and a dull red (not amber) core light so it reads as
  // the cheaper, more polluting choice at a glance.
  generator_coal: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="coalHousing" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{HOUSING_HI}}"/>
      <stop offset="100%" stop-color="{{HOUSING}}"/>
    </linearGradient>
  </defs>
  <rect x="10" y="20" width="80" height="66" rx="5" fill="url(#coalHousing)" stroke="{{OUTLINE}}" stroke-width="3.5"/>
  <rect x="60" y="6" width="10" height="17" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <path d="M 16 86 L 41 58 L 64 86 Z" fill="{{COAL}}" stroke="{{OUTLINE}}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M 28 86 L 46 66 L 60 86 Z" fill="{{COAL_HI}}"/>
  <circle cx="68" cy="38" r="15" fill="{{CORE}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Wind generator: a slim mast + three static blades read as a turbine silhouette even without
  // per-frame rotation (an actual spin was tried and cost more than it added at this sprite
  // size). Blade color follows the sited/crowded siting tradeoff at the call site.
  generator_wind: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="46" y="50" width="8" height="44" fill="{{MAST}}" stroke="{{OUTLINE}}" stroke-width="2.6"/>
  <g stroke="{{OUTLINE}}" stroke-width="2.2">
    <ellipse cx="50" cy="26" rx="7" ry="24" fill="{{BLADE}}" transform="rotate(0 50 50)"/>
    <ellipse cx="50" cy="26" rx="7" ry="24" fill="{{BLADE}}" transform="rotate(120 50 50)"/>
    <ellipse cx="50" cy="26" rx="7" ry="24" fill="{{BLADE}}" transform="rotate(240 50 50)"/>
  </g>
  <circle cx="50" cy="50" r="7" fill="{{HUB}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Solar generator: a tilted panel array (parallelogram, not a square, so it doesn't read as
  // another generic box) with grid lines parallel to the tilt. Panel/grid tint follows the
  // open-sky/enclosed siting tradeoff at the call site, same idea as the wind turbine above.
  generator_solar: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="solarPanel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{PANEL_HI}}"/>
      <stop offset="100%" stop-color="{{PANEL}}"/>
    </linearGradient>
  </defs>
  <path d="M 5 80 L 30 15 L 95 15 L 70 80 Z" fill="url(#solarPanel)" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 26.7 80 L 51.7 15" stroke="{{GRID}}" stroke-width="2"/>
  <path d="M 48.3 80 L 73.3 15" stroke="{{GRID}}" stroke-width="2"/>
</svg>`.trim(),

  // Pump: a small well/tower silhouette (drum + water-level band + raised spout), distinct from
  // the generator family's boxy housing so the two source-building families don't read as
  // siblings.
  pump: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="pumpDrum" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{DRUM_HI}}"/>
      <stop offset="100%" stop-color="{{DRUM}}"/>
    </linearGradient>
  </defs>
  <rect x="44" y="6" width="12" height="30" fill="{{SPOUT}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <ellipse cx="50" cy="58" rx="36" ry="34" fill="url(#pumpDrum)" stroke="{{OUTLINE}}" stroke-width="3.2"/>
  <ellipse cx="50" cy="66" rx="28" ry="16" fill="{{WATER}}"/>
</svg>`.trim(),

  // Recycling/garbage garage: shared silhouette for both haul-truck depots (see render.js's
  // garage_recycling/garage_garbage), distinguished only by the FILL tint the caller passes (green
  // vs amber) -- a small depot box with a dark garage-door opening.
  garage: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="garageShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="7" y="9" width="86" height="82" rx="3" fill="url(#garageShade)" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 7 26 H 93" stroke="{{OUTLINE}}" stroke-width="2.5" stroke-opacity="0.5"/>
  <rect x="22" y="44" width="56" height="42" fill="{{DOOR}}" stroke="{{OUTLINE}}" stroke-width="3"/>
</svg>`.trim(),

  // Recycling center: keeps the original three-chevron recycling-arrow motif (the classic
  // "chasing arrows" glyph), just baked into the sprite instead of drawn as a single Canvas
  // diamond -- one arrow path repeated at 0/120/240 degree rotations around center.
  recycling_center: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="recycleShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="6" y="8" width="88" height="84" rx="3" fill="url(#recycleShade)" stroke="{{OUTLINE}}" stroke-width="5"/>
  <g fill="{{ARROW}}" stroke="{{OUTLINE}}" stroke-width="2" stroke-linejoin="round">
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z"/>
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z" transform="rotate(120 50 50)"/>
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z" transform="rotate(240 50 50)"/>
  </g>
</svg>`.trim(),

  // Waste storage: hazard-striped drum cluster -- two diagonal-striped drums inside a housing
  // frame, distinct from the recycling center's green arrow icon (this is the nuclear-waste loop,
  // not the pollution/recycling loop -- see siege.js's tickNuclearHazard).
  waste_storage: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="drumHousingShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
    <pattern id="hazardStripe" width="12" height="12" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="12" height="12" fill="{{STRIPE_DARK}}"/>
      <rect width="6" height="12" fill="{{STRIPE_LIGHT}}"/>
    </pattern>
  </defs>
  <rect x="8" y="12" width="84" height="76" rx="4" fill="url(#drumHousingShade)" stroke="{{OUTLINE}}" stroke-width="5"/>
  <rect x="15" y="18" width="30" height="62" rx="7" fill="url(#hazardStripe)" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <rect x="55" y="18" width="30" height="62" rx="7" fill="url(#hazardStripe)" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <circle cx="30" cy="22" r="9" fill="{{CAP}}" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <circle cx="70" cy="22" r="9" fill="{{CAP}}" stroke="{{OUTLINE}}" stroke-width="2.5"/>
</svg>`.trim(),

  // Delivery truck (haul vehicles, see render.js's _drawVehicles): a boxy cargo box with a raised
  // cab up front, distinct from the building silhouettes above. FILL tints the cargo box per
  // v.kind (recycling green vs garbage amber); STRIPE is baked in (not a Canvas overlay) so it
  // carries the FUEL_COLOR fuel-type tradeoff stripe exactly where it always was, painted onto
  // the cargo box rather than composited after the fact.
  truck: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="truckShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <rect x="6" y="40" width="88" height="42" rx="4" fill="url(#truckShade)" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="9" y="43" width="82" height="9" fill="{{STRIPE}}"/>
  <rect x="30" y="18" width="40" height="26" rx="5" fill="{{CAB}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="37" y="24" width="26" height="11" rx="2" fill="{{WINDOW}}"/>
</svg>`.trim(),

  // Ore deposit / resource node (see render.js's _drawResourceNodes): a jagged rock silhouette
  // with a lighter vein facet, replacing the old Canvas polygon 1:1 in outline shape so the
  // amount-based scaling behavior (caller passes a shrinking `size`) needs no changes here.
  ore_deposit: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="rockShade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{{FILL_HI}}"/>
      <stop offset="100%" stop-color="{{FILL}}"/>
    </linearGradient>
  </defs>
  <path d="M 4 78 L 22 42 L 36 16 L 62 24 L 88 46 L 96 82 L 66 94 L 30 92 Z"
        fill="url(#rockShade)" stroke="{{OUTLINE}}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M 34 60 L 48 34 L 60 44 L 50 66 Z" fill="{{VEIN}}" opacity="0.85"/>
</svg>`.trim(),
};

export const SPRITE_IDS = Object.keys(TEMPLATES);
