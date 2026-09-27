// Shared GLSL: multiplane camera projection + noise.

export const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
`;

export const CAMERA = /* glsl */ `
uniform vec4 uCam;    // camera x, y, z (distance axis), focal length in px
uniform vec2 uRes;
uniform float uRoll;
uniform float uTime;
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }
vec4 project(vec3 p) {
  float dz = max(uCam.z - p.z, 1e-3);
  vec2 d = rot2(p.xy - uCam.xy, -uRoll);
  return vec4(d * uCam.w / dz / (uRes * 0.5), 0.0, 1.0);
}
vec2 unproject(vec2 frag, float z) {
  float dz = uCam.z - z;
  vec2 d = (frag - uRes * 0.5) * dz / uCam.w;
  return rot2(d, uRoll) + uCam.xy;
}
float pxAt(float z) { return (uCam.z - z) / uCam.w; } // world units per pixel on plane z
`;

export const NOISE = /* glsl */ `
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 OCT = mat2(1.6, 1.2, -1.2, 1.6); // rotate + scale each octave: no grid artefacts
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = OCT * p + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = OCT * p + vec2(11.7, 3.1); a *= 0.5; }
  return s;
}
// cellular: x = distance to nearest, y = distance to edge (second - first)
vec2 voronoi(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(sqrt(d1), sqrt(d2) - sqrt(d1));
}
// cellular with the nearest cell's id: x = d1, y = d2 - d1, z = id hash
vec3 voronoiId(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; best = n + g; } else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash12(best + 0.37));
}
// cellular for foliage: xy = offset from pixel to the nearest centre, z = id, w = edge distance
vec4 voronoiLeaf(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0), off = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; best = n + g; off = r; } else if (d < d2) { d2 = d; }
  }
  return vec4(off, hash12(best + 0.37), sqrt(d2) - sqrt(d1));
}
// hill profile shared with JS (scene/ground.js) — keep identical
float hillRaw(float x) {
  return 1.1 * exp(-x * x / 1800.0) + 0.35 * sin(x * 0.045 + 1.3) + 0.18 * sin(x * 0.11 + 0.4) + 0.06 * sin(x * 0.37 + 2.0) - 0.00009 * x * x;
}
float hill(float x) { return hillRaw(x) - hillRaw(0.0); }
`;

export const QUAD_VS = /* glsl */ `
layout(location=0) in vec2 aCorner;
`;
