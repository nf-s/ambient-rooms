// Canvas rendering for the rose window. A static layer holds the nave, stone
// and unlit glass; each pane has prebuilt glass, pale and glow sprites that are
// composited additively each frame at the pane's current brightness.

// Glass colours by scale degree (index 7 is the octave).
const PALETTE = [
  [222, 170, 80], // pale gold
  [42, 78, 196], // deep blue
  [178, 32, 60], // ruby
  [116, 64, 182], // violet
  [222, 128, 38], // amber
  [36, 98, 212], // cobalt
  [152, 30, 82], // garnet
  [222, 170, 80], // pale gold
];
const OCULUS_TINT = [250, 222, 164];
const WARM_WHITE = [255, 245, 228];
const STONE_SHADE = 0.6;
const SPILL = 0.3;
const GLOW_SCALE = 0.5;
const UNLIT = 0.085;
const VISIBLE = 0.003;

function mix(a, b, amount) {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

function scale(colour, amount) {
  return [colour[0] * amount, colour[1] * amount, colour[2] * amount];
}

function rgba(colour, alpha = 1) {
  return `rgba(${Math.round(colour[0])}, ${Math.round(colour[1])}, ${Math.round(colour[2])}, ${alpha})`;
}

function makeLayer(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function sampleGrid(values, cells, u, v) {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const at = (gx, gy) => values[((gy + cells) % cells) * cells + ((gx + cells) % cells)];
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

// Tileable dark mottling, used for the seedy texture of the glass and stone.
function makeMottle() {
  const size = 128;
  const layer = makeLayer(size, size);
  if (!layer) return null;
  const octaves = [
    { cells: 4, weight: 0.4 },
    { cells: 8, weight: 0.28 },
    { cells: 16, weight: 0.2 },
    { cells: 32, weight: 0.12 },
  ].map((octave) => ({ ...octave, values: Float32Array.from({ length: octave.cells ** 2 }, () => Math.random()) }));
  const image = layer.context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 0;
      for (const octave of octaves) value += octave.weight * sampleGrid(octave.values, octave.cells, x / size, y / size);
      const offset = (y * size + x) * 4;
      image.data[offset] = 8;
      image.data[offset + 1] = 5;
      image.data[offset + 2] = 3;
      image.data[offset + 3] = Math.round(Math.min(1, Math.max(0, (value - 0.32) * 1.7)) * 255);
    }
  }
  layer.context.putImageData(image, 0, 0);
  return layer.canvas;
}

function makeHalo() {
  const size = 256;
  const layer = makeLayer(size, size);
  if (!layer) return null;
  const centre = size / 2;
  const gradient = layer.context.createRadialGradient(centre, centre, 0, centre, centre, centre);
  gradient.addColorStop(0, "rgba(255, 220, 172, 0.5)");
  gradient.addColorStop(0.32, "rgba(250, 206, 160, 0.16)");
  gradient.addColorStop(0.7, "rgba(240, 196, 150, 0.04)");
  gradient.addColorStop(1, "rgba(240, 196, 150, 0)");
  layer.context.fillStyle = gradient;
  layer.context.fillRect(0, 0, size, size);
  return layer.canvas;
}

function mottlePattern(context, mottle, radius) {
  if (!mottle) return null;
  const pattern = context.createPattern(mottle, "repeat");
  if (!pattern) return null;
  const size = Math.max(0.5, radius / 380);
  pattern.setTransform(new DOMMatrix([size, 0, 0, size, 0, 0]));
  return pattern;
}

function glassSprite(shape, colour, ratio, mottle, radius, lift) {
  const { bbox } = shape;
  const layer = makeLayer(bbox.w * ratio, bbox.h * ratio);
  if (!layer) return null;
  const context = layer.context;
  context.setTransform(ratio, 0, 0, ratio, -bbox.x * ratio, -bbox.y * ratio);
  context.save();
  context.clip(shape.path);

  const body = context.createRadialGradient(shape.lightX, shape.lightY, 0, shape.lightX, shape.lightY, shape.reach);
  body.addColorStop(0, rgba(mix(colour, WARM_WHITE, lift)));
  body.addColorStop(0.45, rgba(colour));
  body.addColorStop(1, rgba(scale(colour, 0.42)));
  context.fillStyle = body;
  context.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);

  const pattern = mottlePattern(context, mottle, radius);
  if (pattern) {
    context.globalAlpha = 0.38;
    context.fillStyle = pattern;
    context.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
    context.globalAlpha = 1;
  }

  const sheen = context.createLinearGradient(bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h);
  sheen.addColorStop(0.3, "rgba(255, 244, 226, 0)");
  sheen.addColorStop(0.46, "rgba(255, 244, 226, 0.07)");
  sheen.addColorStop(0.62, "rgba(255, 244, 226, 0)");
  context.globalCompositeOperation = "lighter";
  context.fillStyle = sheen;
  context.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
  context.globalCompositeOperation = "source-over";

  // The lead came: a dark rim fading inward from the stone.
  context.lineJoin = "round";
  context.strokeStyle = "rgba(10, 6, 4, 0.22)";
  context.lineWidth = shape.lead * 6;
  context.stroke(shape.path);
  context.strokeStyle = "rgba(10, 6, 4, 0.6)";
  context.lineWidth = shape.lead * 2.2;
  context.stroke(shape.path);
  context.restore();

  if (shape.cusps) {
    context.globalCompositeOperation = "destination-out";
    context.fill(shape.cusps);
    context.globalCompositeOperation = "source-over";
  }
  return layer.canvas;
}

// A soft bloom made from the pane's shadow, drawn with the shape itself pushed
// off the canvas so only the blurred shadow lands in the sprite.
function glowSprite(shape, colour, radius) {
  const blur = radius * 0.1;
  const pad = blur * 1.9;
  const width = shape.bbox.w + pad * 2;
  const height = shape.bbox.h + pad * 2;
  const layer = makeLayer(width * GLOW_SCALE, height * GLOW_SCALE);
  if (!layer) return null;
  const context = layer.context;
  const shift = layer.canvas.width + 256;
  context.setTransform(
    GLOW_SCALE,
    0,
    0,
    GLOW_SCALE,
    (pad - shape.bbox.x) * GLOW_SCALE - shift,
    (pad - shape.bbox.y) * GLOW_SCALE,
  );
  context.shadowOffsetX = shift;
  context.shadowOffsetY = 0;
  context.fillStyle = "#000";
  context.shadowColor = rgba(colour, 0.8);
  context.shadowBlur = blur * GLOW_SCALE * 1.6;
  context.fill(shape.path);
  context.shadowColor = rgba(colour, 0.55);
  context.shadowBlur = blur * GLOW_SCALE * 0.45;
  context.fill(shape.path);
  return { canvas: layer.canvas, x: shape.bbox.x - pad, y: shape.bbox.y - pad, w: width, h: height };
}

function spritesFor(shape, colour, ratio, mottle, radius, withPale) {
  return {
    lit: glassSprite(shape, colour, ratio, mottle, radius, 0.28),
    pale: withPale ? glassSprite(shape, mix(colour, WARM_WHITE, 0.62), ratio, mottle, radius, 0.5) : null,
    glow: glowSprite(shape, mix(colour, WARM_WHITE, 0.18), radius),
  };
}

function drawStone(context, layout, mottle) {
  const { cx, cy, radius } = layout;
  const stone = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
  stone.addColorStop(0, "#201914");
  stone.addColorStop(0.75, "#1a1411");
  stone.addColorStop(1, "#130f0d");
  context.save();
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = stone;
  context.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  const pattern = mottlePattern(context, mottle, radius);
  if (pattern) {
    context.globalAlpha = 0.4;
    context.fillStyle = pattern;
    context.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  context.restore();
}

function ringStroke(context, cx, cy, r, colour, width) {
  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.stroke();
}

function drawSprite(context, canvas, bbox) {
  context.drawImage(canvas, bbox.x, bbox.y, bbox.w, bbox.h);
}

function buildStatic(layout, width, height, ratio, paneSprites, oculusSprites, mottle) {
  const layer = makeLayer(width * ratio, height * ratio);
  if (!layer) return null;
  const context = layer.context;
  const { cx, cy, radius } = layout;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  context.fillStyle = "#0a0807";
  context.fillRect(0, 0, width, height);
  const wall = context.createRadialGradient(cx, cy, radius * 0.9, cx, cy, radius * 2.3);
  wall.addColorStop(0, "rgba(46, 35, 28, 0.8)");
  wall.addColorStop(0.4, "rgba(28, 21, 17, 0.5)");
  wall.addColorStop(1, "rgba(10, 8, 7, 0)");
  context.fillStyle = wall;
  context.fillRect(0, 0, width, height);

  context.beginPath();
  context.arc(cx, cy, radius * 1.075, 0, Math.PI * 2);
  context.fillStyle = "#0f0c0a";
  context.fill();
  const hair = Math.max(1, radius * 0.003);
  ringStroke(context, cx, cy, radius * 1.072, "rgba(150, 124, 98, 0.14)", hair);
  ringStroke(context, cx, cy, radius * 1.05, "rgba(0, 0, 0, 0.5)", hair * 2.5);
  ringStroke(context, cx, cy, radius * 1.036, "rgba(150, 124, 98, 0.1)", hair);
  ringStroke(context, cx, cy, radius * 1.012, "rgba(0, 0, 0, 0.55)", hair * 3);

  drawStone(context, layout, mottle);

  const glass = [...layout.shapes, layout.oculus];
  const sprites = [...paneSprites, oculusSprites];
  glass.forEach((shape, index) => {
    context.fillStyle = "#070505";
    context.fill(shape.path);
    const lit = sprites[index].lit;
    if (lit) {
      context.globalAlpha = UNLIT;
      drawSprite(context, lit, shape.bbox);
      context.globalAlpha = 1;
    }
  });

  context.save();
  context.clip(layout.cusps);
  drawStone(context, layout, mottle);
  context.restore();

  context.lineJoin = "round";
  context.lineWidth = hair;
  context.strokeStyle = "rgba(176, 146, 116, 0.17)";
  glass.forEach((shape) => context.stroke(shape.path));
  context.stroke(layout.cusps);

  layout.incised.forEach((r) => {
    ringStroke(context, cx, cy, r, "rgba(0, 0, 0, 0.45)", hair * 1.6);
    ringStroke(context, cx, cy, r + hair * 1.4, "rgba(176, 146, 116, 0.08)", hair);
  });
  return layer;
}

// Stone only, with the glass cut out, laid over the bloom so that most of the
// spill is held back by the tracery and only a little light passes it.
function buildStoneMask(layout, width, height, ratio, staticLayer) {
  const { cx, cy, radius } = layout;
  const size = radius * 2;
  const layer = makeLayer(size * ratio, size * ratio);
  if (!layer) return null;
  const context = layer.context;
  context.setTransform(ratio, 0, 0, ratio, -(cx - radius) * ratio, -(cy - radius) * ratio);
  context.save();
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.clip();
  context.drawImage(staticLayer.canvas, 0, 0, width, height);
  context.restore();
  context.globalCompositeOperation = "destination-out";
  layout.shapes.forEach((shape) => context.fill(shape.path));
  context.fill(layout.oculus.path);
  context.globalCompositeOperation = "source-over";
  context.save();
  context.clip(layout.cusps);
  context.drawImage(staticLayer.canvas, 0, 0, width, height);
  context.restore();
  return { canvas: layer.canvas, x: cx - radius, y: cy - radius, w: size, h: size };
}

export function createRenderer(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const mottle = makeMottle();
  const halo = makeHalo();
  let width = 0;
  let height = 0;
  let ratio = 1;
  let layout = null;
  let staticLayer = null;
  let stoneMask = null;
  let paneSprites = [];
  let oculusSprites = null;

  function resize(nextLayout, nextWidth, nextHeight, nextRatio, panes) {
    layout = nextLayout;
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const radius = layout.radius;
    paneSprites = layout.shapes.map((shape, index) =>
      spritesFor({ ...shape, lead: layout.lead }, PALETTE[panes[index].petal], ratio, mottle, radius, true),
    );
    oculusSprites = spritesFor({ ...layout.oculus, lead: layout.lead }, OCULUS_TINT, ratio, mottle, radius, false);
    staticLayer = buildStatic(layout, width, height, ratio, paneSprites, oculusSprites, mottle);
    stoneMask = staticLayer ? buildStoneMask(layout, width, height, ratio, staticLayer) : null;
  }

  // view: { melody: Float32Array, tvoice: Float32Array, oculus, total }
  function draw(view) {
    if (!layout) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    if (staticLayer) {
      context.drawImage(staticLayer.canvas, 0, 0);
    } else {
      context.fillStyle = "#0a0807";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (view.total < VISIBLE) return;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalCompositeOperation = "lighter";
    if (halo) {
      const size = layout.radius * 3.4;
      context.globalAlpha = Math.min(0.45, view.total * 0.045);
      context.drawImage(halo, layout.cx - size / 2, layout.cy - size / 2, size, size);
    }
    for (let index = 0; index < paneSprites.length; index += 1) {
      const level = Math.max(view.melody[index], view.tvoice[index] * 0.8);
      const glow = paneSprites[index].glow;
      if (level < VISIBLE || !glow) continue;
      context.globalAlpha = Math.min(1, level * 1.6);
      drawSprite(context, glow.canvas, glow);
    }
    if (view.oculus >= VISIBLE && oculusSprites && oculusSprites.glow) {
      context.globalAlpha = Math.min(1, view.oculus * 0.85);
      drawSprite(context, oculusSprites.glow.canvas, oculusSprites.glow);
    }

    if (stoneMask) {
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = STONE_SHADE;
      drawSprite(context, stoneMask.canvas, stoneMask);
      context.globalCompositeOperation = "lighter";
    }

    // A little light carried back over the tracery around each lit pane.
    for (let index = 0; index < paneSprites.length; index += 1) {
      const level = Math.max(view.melody[index], view.tvoice[index] * 0.8);
      const glow = paneSprites[index].glow;
      if (level < VISIBLE || !glow) continue;
      context.globalAlpha = Math.min(1, level * SPILL);
      drawSprite(context, glow.canvas, glow);
    }

    for (let index = 0; index < paneSprites.length; index += 1) {
      const sprites = paneSprites[index];
      const bbox = layout.shapes[index].bbox;
      if (view.melody[index] >= VISIBLE && sprites.lit) {
        context.globalAlpha = Math.min(1, Math.sqrt(view.melody[index]) * 1.15);
        drawSprite(context, sprites.lit, bbox);
      }
      if (view.tvoice[index] >= VISIBLE && sprites.pale) {
        context.globalAlpha = Math.min(1, Math.sqrt(view.tvoice[index]) * 1.15);
        drawSprite(context, sprites.pale, bbox);
      }
    }
    if (view.oculus >= VISIBLE && oculusSprites && oculusSprites.lit) {
      context.globalAlpha = Math.min(1, view.oculus);
      drawSprite(context, oculusSprites.lit, layout.oculus.bbox);
    }
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
  }

  return { resize, draw };
}
