// Colours for the canvas layers in the light and dark themes. Every entry is
// [r, g, b, a] with channels 0–255 and alpha 0–1, so the two themes can be
// blended for a cross-fade.

const LIGHT = {
  pageCentre: [228, 231, 235, 1],
  pageEdge: [228, 231, 235, 1],
  plateShadow: [30, 41, 59, 0.14],
  plateBase: [244, 245, 247, 1],
  faceHighlight: [253, 253, 254, 1],
  faceMiddle: [246, 247, 249, 1],
  faceEdge: [236, 238, 242, 1],
  sheen: [255, 255, 255, 0],
  lathe: [100, 116, 139, 0],
  rimOuter: [100, 116, 139, 0.32],
  rimInner: [255, 255, 255, 0.9],
  bolt: [227, 231, 236, 1],
  boltStroke: [100, 116, 139, 0.3],
  tick: [71, 85, 105, 0.38],
  numeral: [71, 85, 105, 0.48],
  numeralOctave: [71, 85, 105, 0.75],
  numeralCurrent: [30, 41, 59, 1],
  ink: [30, 38, 50, 1],
  markerHalo: [255, 255, 255, 0.4],
  markerFill: [255, 255, 255, 1],
  markerStroke: [51, 65, 85, 0.85],
  guide: [71, 85, 105, 0.2],
  // Sand: colour of the densest grains, of the lightest dust, alpha of the
  // densest grains, how much the dust fades, and warm/cool spread per grain.
  sandStrong: [26, 33, 46, 1],
  sandFaint: [102, 115, 133, 1],
  sandAlpha: [0.94, 0.3, 0, 1],
  sandWarm: [0, 0, 0, 0],
};

const DARK = {
  pageCentre: [20, 25, 33, 1],
  pageEdge: [7, 9, 13, 1],
  plateShadow: [0, 0, 0, 0.6],
  plateBase: [24, 27, 33, 1],
  faceHighlight: [58, 63, 72, 1],
  faceMiddle: [34, 38, 45, 1],
  faceEdge: [20, 23, 28, 1],
  sheen: [214, 224, 240, 0.07],
  lathe: [200, 210, 225, 0.022],
  rimOuter: [0, 0, 0, 0.7],
  rimInner: [190, 200, 215, 0.16],
  bolt: [46, 50, 58, 1],
  boltStroke: [170, 180, 196, 0.22],
  tick: [206, 212, 222, 0.32],
  numeral: [206, 212, 222, 0.42],
  numeralOctave: [218, 223, 231, 0.72],
  numeralCurrent: [244, 241, 234, 1],
  ink: [218, 215, 207, 1],
  markerHalo: [10, 12, 16, 0.55],
  markerFill: [16, 19, 24, 1],
  markerStroke: [236, 232, 224, 0.95],
  guide: [214, 208, 196, 0.13],
  sandStrong: [240, 232, 214, 1],
  sandFaint: [138, 138, 136, 1],
  sandAlpha: [0.95, 0.5, 0, 1],
  sandWarm: [10, 2, -10, 1],
};

const KEYS = Object.keys(LIGHT);

// Theme blend: 0 is light, 1 is dark.
export function mixPalette(amount) {
  const t = Math.min(1, Math.max(0, amount));
  const palette = {};
  KEYS.forEach((key) => {
    const from = LIGHT[key];
    const to = DARK[key];
    palette[key] = from.map((value, index) => value + (to[index] - value) * t);
  });
  return palette;
}

export function css(colour, alphaScale = 1) {
  const [r, g, b, a] = colour;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a * alphaScale).toFixed(3)})`;
}
