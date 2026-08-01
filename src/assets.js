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
  // Style brief applied: flat base fill + ONE solid highlight shape per part (clipped to that
  // part's own silhouette, no gradients) instead of the old top-to-bottom bodyShade/headShade
  // gradients -- BODY_HI/HEAD_HI are solid colors, not gradient stops, computed by render.js's
  // shade(). Head radius bumped 19->21 (and re-centered) for a slightly chunkier head-to-torso
  // ratio, RimWorld/PA-pawn style; hair paths nudged outward to match.
  humanoid_torso: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="torsoClip">
      <path d="M 28 92 Q 24 60 32 40 Q 36 28 50 26 Q 64 28 68 40 Q 76 60 72 92 Q 50 100 28 92 Z"/>
    </clipPath>
    <clipPath id="headClip"><circle cx="50" cy="23" r="21"/></clipPath>
  </defs>
  <path d="M 28 92 Q 24 60 32 40 Q 36 28 50 26 Q 64 28 68 40 Q 76 60 72 92 Q 50 100 28 92 Z"
        fill="{{BODY}}" stroke="{{OUTLINE}}" stroke-width="3.2" stroke-linejoin="round"/>
  <ellipse cx="41" cy="37" rx="20" ry="13" fill="{{BODY_HI}}" clip-path="url(#torsoClip)"/>
  <circle cx="50" cy="23" r="21" fill="{{HEAD}}" stroke="{{OUTLINE}}" stroke-width="3.2"/>
  <ellipse cx="42" cy="14" rx="10" ry="6.5" fill="{{HEAD_HI}}" clip-path="url(#headClip)"/>
  <path d="M 30 14 Q 50 1 70 14 Q 70 7 50 5 Q 30 7 30 14 Z" fill="{{HAIR}}"/>
  <path d="M 30 14 Q 32 25 30 31 Q 25 22 26 16 Q 27 13 30 14 Z" fill="{{HAIR}}"/>
  <path d="M 70 14 Q 68 25 70 31 Q 75 22 74 16 Q 73 13 70 14 Z" fill="{{HAIR}}"/>
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
  // Style brief applied here too: flat COAT fill + one small solid COAT_HI highlight ellipse per
  // part (clipped to that part's own silhouette), no gradient.
  animal_body: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="animalBodyClip"><ellipse cx="42" cy="58" rx="34" ry="22"/></clipPath>
    <clipPath id="animalHeadClip"><circle cx="76" cy="42" r="17"/></clipPath>
  </defs>
  <ellipse cx="42" cy="58" rx="34" ry="22" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <ellipse cx="34" cy="42" rx="18" ry="10" fill="{{COAT_HI}}" clip-path="url(#animalBodyClip)"/>
  <circle cx="76" cy="42" r="17" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <ellipse cx="70" cy="32" rx="8" ry="6" fill="{{COAT_HI}}" clip-path="url(#animalHeadClip)"/>
  <path d="M 68 30 L 64 16 L 76 26 Z" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M 82 28 L 86 14 L 90 27 Z" fill="{{COAT}}" stroke="{{OUTLINE}}" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="82" cy="40" r="2.6" fill="{{OUTLINE}}"/>
</svg>`.trim(),

  // Wall: deliberately plain -- it's the cheapest, most-placed structure, so a blocky slab with
  // a couple of mortar-line seams reads as "solid barrier" at a glance without adding per-tile
  // visual noise once dozens are placed edge-to-edge.
  // RimWorld/PA style-brief pass: full-surface gradient replaced with a flat base fill + one
  // small solid highlight wedge in the upper-left (the light-source convention used across every
  // defense-category sprite in this file, matching the humanoid pass's upper-left-biased radial
  // highlights above).
  wall: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="8" y="8" width="84" height="84" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 8 8 L 44 8 L 8 44 Z" fill="{{FILL_HI}}"/>
  <path d="M 8 36 H 92 M 8 64 H 92 M 32 8 V 36 M 68 36 V 64 M 32 64 V 92" stroke="{{OUTLINE}}" stroke-width="3" stroke-opacity="0.5"/>
</svg>`.trim(),

  // Trap: a spring-loaded jaw motif, small and low so it still reads as "hidden hazard" rather
  // than a prominent structure. Hazard color (the red fill/teeth) is the deliberate full-
  // saturation exception to the category's desaturated palette -- untouched by this pass, only
  // the base's shading technique changed (flat + highlight, no gradient).
  trap: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="32" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 38 34 A 18 18 0 0 1 60 30 L 52 40 A 8 8 0 0 0 40 42 Z" fill="{{FILL_HI}}"/>
  <path d="M 50 22 L 58 44 L 50 50 L 42 44 Z M 78 50 L 56 58 L 50 50 L 56 42 Z
           M 50 78 L 42 56 L 50 50 L 58 56 Z M 22 50 L 44 42 L 50 50 L 44 58 Z"
        fill="{{TEETH}}" stroke="{{OUTLINE}}" stroke-width="2" stroke-linejoin="round"/>
</svg>`.trim(),

  // Turret: a rotating gun housing on a round base -- a distinct round silhouette (vs. the wall's
  // square block) topped by a short barrel so it reads as "this one shoots back." Institutional/
  // metal per the style brief -- cool gray-blue FILL supplied by render.js, flat + single
  // highlight wedge instead of the old radial gradient.
  turret: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="12" y="12" width="76" height="76" rx="10" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 16 16 L 44 16 L 16 44 Z" fill="{{FILL_HI}}"/>
  <circle cx="50" cy="50" r="26" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 36 36 A 14 14 0 0 1 58 32 L 50 44 A 6 6 0 0 0 40 46 Z" fill="{{FILL_HI}}"/>
  <rect x="43" y="6" width="14" height="40" rx="4" fill="{{BARREL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <circle cx="50" cy="50" r="10" fill="{{BARREL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Tesla coil: a squat base with an arcing-ring motif above it. The ring can't animate as a
  // static SVG, so the "electricity" read comes from the bright ring color + spark ticks instead
  // of motion. The ARC/spark stroke is the charge-glow hazard exception (kept fully saturated,
  // the one gradient-adjacent accent this pass explicitly preserves) -- only the base housing's
  // shading technique changed to flat + highlight.
  tesla: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="66" rx="30" ry="22" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 26 58 A 24 18 0 0 1 46 46 L 40 62 A 10 8 0 0 0 30 68 Z" fill="{{FILL_HI}}"/>
  <rect x="46" y="24" width="8" height="30" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <circle cx="50" cy="26" r="18" fill="none" stroke="{{ARC}}" stroke-width="4"/>
  <path d="M 50 12 L 46 26 L 54 26 L 50 40" fill="none" stroke="{{ARC}}" stroke-width="3" stroke-linejoin="round"/>
</svg>`.trim(),

  // Floodlight: a slim post topped by a lamp housing -- the glow itself stays a separate Canvas
  // radial (drawn by the caller before/after this sprite) since a baked-in glow wouldn't dim
  // correctly when destroyed. Housing gets the same flat + upper-left-highlight treatment as the
  // rest of the category; LAMP stays untouched (it's the light source itself, not a hazard cue).
  floodlight: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="44" y="40" width="12" height="52" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 30 40 L 70 40 L 60 22 L 40 22 Z" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 40 22 L 52 22 L 40 34 Z" fill="{{HOUSING_HI}}"/>
  <circle cx="50" cy="30" r="11" fill="{{LAMP}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),

  // Armory: fortified small building with the crossed-rifles motif baked directly into the
  // silhouette instead of drawn as a separate overlay. Institutional/metal base (cool gray-blue,
  // flat + highlight per the style brief) with a small ammo-crate accent kept at full saturation
  // as the deliberate hazard-color exception, same idea as tesla's charge glow.
  armory: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="9" y="12" width="82" height="76" rx="4" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 9 12 L 45 12 L 9 46 Z" fill="{{FILL_HI}}"/>
  <path d="M 30 30 L 70 70 M 30 70 L 70 30" stroke="{{GLYPH}}" stroke-width="6" stroke-linecap="round"/>
  <rect x="16" y="70" width="20" height="12" rx="1.5" fill="{{AMMO}}" stroke="{{OUTLINE}}" stroke-width="2"/>
</svg>`.trim(),

  // Watchtower: a raised platform on a support post -- kept taller/narrower than the other
  // structure icons so it silhouettes distinctly at a glance even at small map scale. Platform is
  // the institutional/metal element (cool gray-blue per the style brief); post stays its warmer
  // wood tone, both now flat + single upper-left highlight instead of the old solid-fill (no
  // gradient existed here before, but the highlight wedge is new).
  watchtower: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="42" y="34" width="16" height="58" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <rect x="12" y="10" width="76" height="30" rx="3" fill="{{PLATFORM}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 12 10 L 40 10 L 12 32 Z" fill="{{PLATFORM_HI}}"/>
  <path d="M 12 40 L 22 52 M 88 40 L 78 52" stroke="{{OUTLINE}}" stroke-width="3" stroke-linecap="round"/>
</svg>`.trim(),

  // Bed: frame + pillow silhouette. Headboard reads as a slightly taller/darker band at the top
  // edge so the sprite has an implied "head end" even though beds are drawn top-down with no
  // sleeping-direction logic elsewhere in the sim.
  // RimWorld/PA style pass: flat base fill + one small solid highlight wedge (upper-left light
  // source, matching every other concurrently-restyled category) replacing the old full-surface
  // linear gradient; palette desaturated toward warm ochre/tan (wood furniture family).
  bed: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" rx="6" fill="{{FRAME}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="10" y="10" width="80" height="16" rx="4" fill="{{HEADBOARD}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <rect x="18" y="32" width="64" height="24" rx="5" fill="{{PILLOW}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <path d="M 14 60 L 30 60 L 14 76 Z" fill="{{FRAME_HI}}"/>
</svg>`.trim(),

  // Table: plain rectangular tabletop with a subtle inset grain line so it doesn't read as a
  // flat solid-color box. Flat fill + upper-left highlight wedge, same shading convention as bed.
  table: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="8" y="12" width="84" height="76" rx="5" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="18" y="22" width="64" height="56" rx="3" fill="none" stroke="{{OUTLINE}}" stroke-width="2" stroke-opacity="0.35"/>
  <path d="M 12 16 L 30 16 L 12 34 Z" fill="{{FILL_HI}}"/>
</svg>`.trim(),

  // Door: a frame + inset panel + small handle dot -- the "obviously just a colored box" fix.
  // The frame is a darker outer band, the panel a flat inset rectangle with a small upper-left
  // highlight wedge (same convention as bed/table) rather than a full-panel gradient.
  door: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="14" y="4" width="72" height="92" rx="3" fill="{{FRAME}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="22" y="12" width="56" height="76" rx="2" fill="{{PANEL}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <path d="M 26 16 L 44 16 L 26 34 Z" fill="{{PANEL_HI}}"/>
  <circle cx="70" cy="50" r="4" fill="{{HANDLE}}" stroke="{{OUTLINE}}" stroke-width="1.6"/>
</svg>`.trim(),

  // Camera: mounting post + angled lens housing, matching the existing primitive's composition
  // (post, rotated housing box, lit lens dot) so the conversion is a faithful redraw rather than
  // a redesign. Lens dot color still comes in via `vars` so destroyed-state tint keeps working.
  // Housing is flat fill + a small solid highlight wedge (upper-left within the rotated group,
  // so it still reads as "upper-left light" once the housing's own -23deg tilt is applied); the
  // lens keeps a genuine small radial glow -- the deliberate screen/lens-glow exception to the
  // flat-shading rule, not the default.
  camera: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="lensGlow" cx="35%" cy="35%" r="75%">
      <stop offset="0%" stop-color="{{LENS_HI}}"/>
      <stop offset="100%" stop-color="{{LENS}}"/>
    </radialGradient>
  </defs>
  <rect x="44" y="46" width="12" height="46" fill="{{POST}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <g transform="translate(50 34) rotate(-23)">
    <rect x="-30" y="-15" width="52" height="26" rx="3" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3"/>
    <path d="M -28 -13 L -12 -13 L -28 3 Z" fill="{{HOUSING_HI}}"/>
    <circle cx="20" cy="-2" r="7" fill="url(#lensGlow)" stroke="{{OUTLINE}}" stroke-width="2"/>
  </g>
</svg>`.trim(),

  // Monitor station: desk + monitor bank, with the two screen tiles colored per-call via `vars`
  // so the staffed/unstaffed/destroyed 3-way state (see render.js's _drawStructureShape) keeps
  // reading correctly -- the SVG itself carries no state, only the substituted screen colors do.
  // Desk/bank are flat fill + small upper-left highlight wedges (style-brief shading rule); the
  // screens keep a genuine small radial glow -- same deliberate exception as the camera lens
  // above, and the one place a gradient is still load-bearing (it's how "staffed" reads as
  // "lit up" versus "unstaffed"/"destroyed" reading as flat/dark).
  monitor_station: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="screenGlow" cx="35%" cy="35%" r="75%">
      <stop offset="0%" stop-color="{{SCREEN_HI}}"/>
      <stop offset="100%" stop-color="{{SCREEN}}"/>
    </radialGradient>
  </defs>
  <rect x="8" y="56" width="84" height="34" rx="3" fill="{{DESK}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 12 60 L 28 60 L 12 76 Z" fill="{{DESK_HI}}"/>
  <rect x="10" y="10" width="80" height="40" rx="3" fill="{{BANK}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="16" y="16" width="32" height="28" rx="2" fill="url(#screenGlow)" stroke="{{OUTLINE}}" stroke-width="2"/>
  <rect x="52" y="16" width="32" height="28" rx="2" fill="url(#screenGlow)" stroke="{{OUTLINE}}" stroke-width="2"/>
</svg>`.trim(),

  // Plain generator: boxy industrial housing (a squared-off cabinet with vent panels) around a
  // glowing core light. The "default" power source silhouette other generator_* variants below
  // deliberately read as heavier/lighter/differently-shaped than.
  generator: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="genCore" cx="50%" cy="50%" r="65%">
      <stop offset="0%" stop-color="{{CORE_HI}}"/>
      <stop offset="100%" stop-color="{{CORE}}"/>
    </radialGradient>
  </defs>
  <rect x="9" y="9" width="82" height="82" rx="7" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3.5"/>
  <rect x="14" y="14" width="30" height="11" rx="2" fill="{{HOUSING_HI}}" opacity="0.85"/>
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
    <radialGradient id="nukeGlow" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="{{CORE_HI}}"/>
      <stop offset="100%" stop-color="{{CORE}}"/>
    </radialGradient>
  </defs>
  <rect x="4" y="4" width="92" height="92" rx="5" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="10" y="10" width="34" height="12" rx="2" fill="{{HOUSING_HI}}" opacity="0.8"/>
  <circle cx="50" cy="50" r="30" fill="{{WELL}}"/>
  <path d="M 50 50 L 41.1 25.6 A 26 26 0 0 1 58.9 25.6 Z" fill="{{CORE}}"/>
  <path d="M 50 50 L 75.6 54.5 A 26 26 0 0 1 66.7 69.9 Z" fill="{{CORE}}"/>
  <path d="M 50 50 L 33.3 69.9 A 26 26 0 0 1 24.4 54.5 Z" fill="{{CORE}}"/>
  <circle cx="50" cy="50" r="8" fill="url(#nukeGlow)"/>
</svg>`.trim(),

  // Coal generator: squatter/dirtier housing than the plain generator, with a coal-pile
  // silhouette out front, a small chimney, and a dull red (not amber) core light so it reads as
  // the cheaper, more polluting choice at a glance.
  generator_coal: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="20" width="80" height="66" rx="5" fill="{{HOUSING}}" stroke="{{OUTLINE}}" stroke-width="3.5"/>
  <rect x="14" y="24" width="28" height="10" rx="2" fill="{{HOUSING_HI}}" opacity="0.8"/>
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
  <rect x="46" y="50" width="3" height="44" fill="{{MAST_HI}}" opacity="0.7"/>
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
  <path d="M 5 80 L 30 15 L 95 15 L 70 80 Z" fill="{{PANEL}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 15 55 L 32 20 L 50 20 L 33 55 Z" fill="{{PANEL_HI}}" opacity="0.55"/>
  <path d="M 26.7 80 L 51.7 15" stroke="{{GRID}}" stroke-width="2"/>
  <path d="M 48.3 80 L 73.3 15" stroke="{{GRID}}" stroke-width="2"/>
</svg>`.trim(),

  // Pump: a small well/tower silhouette (drum + water-level band + raised spout), distinct from
  // the generator family's boxy housing so the two source-building families don't read as
  // siblings.
  pump: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="44" y="6" width="12" height="30" fill="{{SPOUT}}" stroke="{{OUTLINE}}" stroke-width="2.4"/>
  <ellipse cx="50" cy="58" rx="36" ry="34" fill="{{DRUM}}" stroke="{{OUTLINE}}" stroke-width="3.2"/>
  <ellipse cx="35" cy="42" rx="13" ry="11" fill="{{DRUM_HI}}" opacity="0.55"/>
  <ellipse cx="50" cy="66" rx="28" ry="16" fill="{{WATER}}"/>
</svg>`.trim(),

  // Recycling/garbage garage: shared silhouette for both haul-truck depots (see render.js's
  // garage_recycling/garage_garbage), distinguished only by the FILL tint the caller passes.
  // RESTYLE (RimWorld/Prison-Architect-conventions pass, economy+vehicle scope): flat base FILL
  // plus one solid upper-left highlight facet (FILL_HI) replacing the old top-to-bottom gradient
  // -- consistent light-source direction with the rest of the game's restyled categories.
  garage: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="7" y="9" width="86" height="82" rx="3" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 7 9 L 40 9 L 24 40 L 7 40 Z" fill="{{FILL_HI}}"/>
  <path d="M 7 26 H 93" stroke="{{OUTLINE}}" stroke-width="2.5" stroke-opacity="0.5"/>
  <rect x="22" y="44" width="56" height="42" fill="{{DOOR}}" stroke="{{OUTLINE}}" stroke-width="3"/>
</svg>`.trim(),

  // Recycling center: keeps the original three-chevron recycling-arrow motif (the classic
  // "chasing arrows" glyph), just baked into the sprite instead of drawn as a single Canvas
  // diamond -- one arrow path repeated at 0/120/240 degree rotations around center. RESTYLE:
  // flat FILL + upper-left highlight facet, gradient removed.
  recycling_center: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="6" y="8" width="88" height="84" rx="3" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 6 8 L 38 8 L 20 40 L 6 40 Z" fill="{{FILL_HI}}"/>
  <g fill="{{ARROW}}" stroke="{{OUTLINE}}" stroke-width="2" stroke-linejoin="round">
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z"/>
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z" transform="rotate(120 50 50)"/>
    <path d="M 50 24 L 62 42 L 54 42 L 54 58 L 46 58 L 46 42 L 38 42 Z" transform="rotate(240 50 50)"/>
  </g>
</svg>`.trim(),

  // Waste storage: hazard-striped drum cluster -- two diagonal-striped drums inside a housing
  // frame, distinct from the recycling center's green arrow icon (this is the nuclear-waste loop,
  // not the pollution/recycling loop -- see siege.js's tickNuclearHazard). RESTYLE: housing shell
  // is flat FILL + upper-left highlight facet (gradient removed); the hazard-stripe pattern itself
  // is the deliberate exception to the desaturated palette and is left at full saturation.
  waste_storage: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <pattern id="hazardStripe" width="12" height="12" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="12" height="12" fill="{{STRIPE_DARK}}"/>
      <rect width="6" height="12" fill="{{STRIPE_LIGHT}}"/>
    </pattern>
  </defs>
  <rect x="8" y="12" width="84" height="76" rx="4" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="5"/>
  <path d="M 8 12 L 40 12 L 22 42 L 8 42 Z" fill="{{FILL_HI}}"/>
  <rect x="15" y="18" width="30" height="62" rx="7" fill="url(#hazardStripe)" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <rect x="55" y="18" width="30" height="62" rx="7" fill="url(#hazardStripe)" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <circle cx="30" cy="22" r="9" fill="{{CAP}}" stroke="{{OUTLINE}}" stroke-width="2.5"/>
  <circle cx="70" cy="22" r="9" fill="{{CAP}}" stroke="{{OUTLINE}}" stroke-width="2.5"/>
</svg>`.trim(),

  // Delivery truck (haul vehicles, see render.js's _drawVehicles): a boxy cargo box with a raised
  // cab up front, distinct from the building silhouettes above. FILL tints the cargo box per
  // v.kind (recycling vs garbage, material-coded -- see render.js); STRIPE is baked in (not a
  // Canvas overlay) so it carries the FUEL_COLOR fuel-type tradeoff stripe exactly where it always
  // was. RESTYLE: cargo box is flat FILL + upper-left highlight facet (gradient removed); STRIPE
  // is drawn on top of the highlight so the fuel-type band stays a flat, clearly-readable color
  // band rather than blending into the body shading.
  truck: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="6" y="40" width="88" height="42" rx="4" fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <path d="M 6 40 L 30 40 L 22 58 L 6 58 Z" fill="{{FILL_HI}}"/>
  <rect x="9" y="43" width="82" height="9" fill="{{STRIPE}}"/>
  <rect x="30" y="18" width="40" height="26" rx="5" fill="{{CAB}}" stroke="{{OUTLINE}}" stroke-width="4"/>
  <rect x="37" y="24" width="26" height="11" rx="2" fill="{{WINDOW}}"/>
</svg>`.trim(),

  // Ore deposit / resource node (see render.js's _drawResourceNodes): a jagged rock silhouette
  // with a lighter vein facet, replacing the old Canvas polygon 1:1 in outline shape so the
  // amount-based scaling behavior (caller passes a shrinking `size`) needs no changes here.
  // RESTYLE: gradient removed -- flat FILL for the rock body, the existing VEIN facet already IS
  // the one-highlight-shape the style brief asks for, so it's kept as-is (just recolored by the
  // caller, see render.js).
  ore_deposit: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 4 78 L 22 42 L 36 16 L 62 24 L 88 46 L 96 82 L 66 94 L 30 92 Z"
        fill="{{FILL}}" stroke="{{OUTLINE}}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M 34 60 L 48 34 L 60 44 L 50 66 Z" fill="{{VEIN}}" opacity="0.85"/>
</svg>`.trim(),

  // Shrine (RimWorld Ideology DLC's real altar buildable, economy.js's BUILD_COST.shrine /
  // rooms.js's BEAUTY_BY_KIND.shrine): a stepped stone pedestal topped by a glowing carved emblem
  // -- distinct silhouette from every furniture/utility category above (no boxy housing, no
  // frame-and-panel) so it reads immediately as "decorative, not functional" at a glance. Flat
  // STONE fill + one solid upper-left highlight facet, same shading convention as every other
  // restyled category; the emblem keeps a genuine small radial glow (the same deliberate
  // screen/lens-glow exception the camera lens and monitor_station screens already use) since a
  // shrine's whole visual point is "this one thing draws the eye."
  shrine: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="shrineGlow" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="{{GLOW_HI}}"/>
      <stop offset="100%" stop-color="{{GLOW}}"/>
    </radialGradient>
  </defs>
  <path d="M 10 92 L 90 92 L 90 80 L 14 80 Z" fill="{{STONE}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 18 80 L 82 80 L 82 66 L 22 66 Z" fill="{{STONE}}" stroke="{{OUTLINE}}" stroke-width="3"/>
  <path d="M 10 92 L 34 92 L 30 80 L 14 80 Z" fill="{{STONE_HI}}"/>
  <path d="M 26 66 L 74 66 L 62 26 L 38 26 Z" fill="{{STONE}}" stroke="{{OUTLINE}}" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M 30 62 L 42 34 L 50 34 L 40 62 Z" fill="{{STONE_HI}}"/>
  <circle cx="50" cy="30" r="13" fill="url(#shrineGlow)" stroke="{{OUTLINE}}" stroke-width="2.4"/>
</svg>`.trim(),
};

export const SPRITE_IDS = Object.keys(TEMPLATES);

// -------------------------------------------------------------------------------------------
// Topbar stat/status glyphs. Same viewBox/outline conventions as TEMPLATES above (0 0 100 100,
// bold {{OUTLINE}}-style stroke, flat fills) but each is a fully baked, single-purpose icon --
// no {{PLACEHOLDER}} recoloring, since every topbar stat has exactly one fixed identity color
// (per the live-observation brief: distinct color per resource so the eye can scan for a
// specific one without reading labels). Kept in their own map/cache rather than folded into
// getSprite/TEMPLATES/drawSprite because those are built around Canvas-drawn game-world sprites
// (centered, scaled, rotated, recolored); topbar icons are plain small <img> tags in static DOM,
// so they only need a data: URI, not the draw-to-canvas machinery.
const TOPBAR_ICONS = {
  // Scrap: hex nut, the game's core currency -- flat pewter fill reads as "metal" at a glance.
  scrap: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <polygon points="50,8 84,28 84,72 50,92 16,72 16,28" fill="#b9b2a4" stroke="#2a2620" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="50" cy="50" r="15" fill="#2a2620"/>
</svg>`.trim(),

  // Population: two overlapping heads/shoulders, cool blue so it reads distinctly from scrap's
  // warm metal tone at a glance.
  population: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M48 94 Q48 66 68 66 Q90 66 90 94 Z" fill="#4c8cb0" stroke="#1c2833" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="68" cy="40" r="16" fill="#4c8cb0" stroke="#1c2833" stroke-width="7"/>
  <path d="M8 92 Q8 58 36 58 Q64 58 64 92 Z" fill="#6fb4d9" stroke="#1c2833" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="36" cy="34" r="20" fill="#6fb4d9" stroke="#1c2833" stroke-width="7"/>
</svg>`.trim(),

  // Attackers: skull, hostile red so it registers as "threat" instantly next to friendly blue.
  attackers: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M50 8 Q82 8 82 42 Q82 60 70 70 L70 86 L58 86 L58 72 L42 72 L42 86 L30 86 L30 70 Q18 60 18 42 Q18 8 50 8 Z"
        fill="#d9534f" stroke="#2a1414" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="38" cy="44" r="9" fill="#2a1414"/>
  <circle cx="62" cy="44" r="9" fill="#2a1414"/>
  <path d="M44 60 L50 70 L56 60 Z" fill="#2a1414"/>
</svg>`.trim(),

  // Wave: two stacked swell lines, cool blue -- distinct hue from both population-blue (lighter,
  // single-tone here) and pollution-green.
  wave: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M6 54 Q22 32 38 54 T70 54 T94 54" fill="none" stroke="#4a90c4" stroke-width="11" stroke-linecap="round"/>
  <path d="M6 76 Q22 54 38 76 T70 76 T94 76" fill="none" stroke="#2c5c80" stroke-width="11" stroke-linecap="round"/>
</svg>`.trim(),

  // Pollution: a murky billowing haze cloud with a drip, sickly green so it reads as "bad" the
  // way the topbar's danger-red text already does for the number next to it.
  pollution: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="28" cy="40" r="17" fill="#7c9c4a" stroke="#22301a" stroke-width="7"/>
  <circle cx="70" cy="36" r="19" fill="#7c9c4a" stroke="#22301a" stroke-width="7"/>
  <ellipse cx="50" cy="52" rx="36" ry="21" fill="#7c9c4a" stroke="#22301a" stroke-width="7"/>
  <path d="M40 74 Q40 94 50 94 Q60 94 60 74" fill="#556b30" stroke="#22301a" stroke-width="6" stroke-linejoin="round"/>
</svg>`.trim(),

  // Unrest: warning triangle, hot orange -- deliberately close to (but distinguishable from)
  // attacker-red so it still reads as "alarm" without being confused with combat threat count.
  unrest: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M50 6 L94 88 L6 88 Z" fill="#e08a36" stroke="#2a1c0c" stroke-width="7" stroke-linejoin="round"/>
  <rect x="44" y="34" width="12" height="30" rx="2" fill="#2a1c0c"/>
  <rect x="44" y="72" width="12" height="12" rx="2" fill="#2a1c0c"/>
</svg>`.trim(),

  // Day: sun disc + rays, warm gold.
  day: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="22" fill="#f0c33e" stroke="#5c4413" stroke-width="7"/>
  <g stroke="#f0c33e" stroke-width="9" stroke-linecap="round">
    <line x1="50" y1="4" x2="50" y2="18"/><line x1="50" y1="82" x2="50" y2="96"/>
    <line x1="4" y1="50" x2="18" y2="50"/><line x1="82" y1="50" x2="96" y2="50"/>
    <line x1="17" y1="17" x2="27" y2="27"/><line x1="73" y1="73" x2="83" y2="83"/>
    <line x1="17" y1="83" x2="27" y2="73"/><line x1="73" y1="27" x2="83" y2="17"/>
  </g>
</svg>`.trim(),

  // Night: crescent moon, cool indigo -- opposite temperature from day's gold so the topbar's
  // day/night swap reads as a real color change, not just a shape swap.
  night: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M64 8 A40 40 0 1 0 64 92 A31 31 0 0 1 64 8 Z" fill="#7f95c9" stroke="#232a44" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="42" cy="34" r="4.5" fill="#232a44"/>
  <circle cx="54" cy="54" r="3" fill="#232a44"/>
</svg>`.trim(),

  // Weather -- Clear: small sun tucked behind a pale cloud (distinct from the bare day-sun icon
  // above so the two don't read as duplicates when both happen to show at once).
  weatherClear: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="64" cy="32" r="18" fill="#f0c33e" stroke="#5c4413" stroke-width="6"/>
  <ellipse cx="40" cy="62" rx="34" ry="20" fill="#dfe6ee" stroke="#4a5566" stroke-width="7"/>
</svg>`.trim(),

  // Weather -- Rain: grey cloud with blue drops.
  weatherRain: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="38" rx="38" ry="21" fill="#9aa8b8" stroke="#333c47" stroke-width="7"/>
  <g stroke="#4a90c4" stroke-width="9" stroke-linecap="round">
    <line x1="30" y1="70" x2="23" y2="90"/><line x1="52" y1="70" x2="45" y2="90"/><line x1="74" y1="70" x2="67" y2="90"/>
  </g>
</svg>`.trim(),

  // Weather -- Cold: snowflake, pale cyan.
  weatherCold: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g stroke="#bfe3f0" stroke-width="8" stroke-linecap="round">
    <line x1="50" y1="6" x2="50" y2="94"/><line x1="6" y1="50" x2="94" y2="50"/>
    <line x1="19" y1="19" x2="81" y2="81"/><line x1="81" y1="19" x2="19" y2="81"/>
  </g>
  <circle cx="50" cy="50" r="9" fill="#bfe3f0" stroke="#2a4a56" stroke-width="4"/>
</svg>`.trim(),

  // Weather -- Heatwave: flame, hot orange-red.
  weatherHeatwave: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M50 6 Q72 32 60 52 Q80 50 72 76 Q65 96 48 96 Q26 96 22 74 Q19 56 34 45 Q31 60 40 61 Q33 38 50 6 Z"
        fill="#e0622f" stroke="#5c2410" stroke-width="7" stroke-linejoin="round"/>
</svg>`.trim(),

  // Grading: shield with a checkmark, gold -- matches --accent so it reads as "quality report"
  // consistent with the rest of the UI's accent color for positive/informational chrome.
  grading: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M50 6 L88 20 L88 46 Q88 78 50 96 Q12 78 12 46 L12 20 Z" fill="#e0a336" stroke="#3a2c10" stroke-width="7" stroke-linejoin="round"/>
  <path d="M32 50 L46 64 L70 34" fill="none" stroke="#3a2c10" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`.trim(),

  // Research: flask, cyan -- distinct cool hue from every other stat's color so it never reads
  // as a variant of population/wave's blues.
  research: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M40 10 H60 V38 L82 78 Q86 88 74 90 H26 Q14 88 18 78 L40 38 Z" fill="#5ecbe0" stroke="#123a44" stroke-width="7" stroke-linejoin="round"/>
  <rect x="36" y="4" width="28" height="10" rx="3" fill="#123a44"/>
  <circle cx="49" cy="70" r="5" fill="#123a44"/>
  <circle cx="61" cy="79" r="4" fill="#123a44"/>
</svg>`.trim(),
};

export const TOPBAR_ICON_IDS = Object.keys(TOPBAR_ICONS);

const _topbarUriCache = new Map();

// Returns a cached data: URI for a topbar glyph by name (one of TOPBAR_ICON_IDS). Unlike
// getSprite/drawSprite above, this is meant for a plain <img src="..."> in static DOM, not a
// Canvas draw call -- topbar icons never need recoloring or rotation, so there's no `vars`/cache
// key complexity to carry over from the sprite system.
export function topbarIconUri(name) {
  let uri = _topbarUriCache.get(name);
  if (uri) return uri;
  const svg = TOPBAR_ICONS[name];
  if (!svg) throw new Error(`assets.js: unknown topbar icon "${name}"`);
  uri = svgDataUri(svg);
  _topbarUriCache.set(name, uri);
  return uri;
}
