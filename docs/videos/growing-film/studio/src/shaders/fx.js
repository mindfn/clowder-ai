// Particles (many kinds), glowing ribbons, captions and the trunk-ring view.
import { HEADER, CAMERA, NOISE } from './common.js';

// kinds: 0 glow, 1 sparkle, 2 leaf, 3 ring, 4 bokeh, 5 fruit, 6 lantern, 7 paper plane, 8 petal
export const PART_VS = `${HEADER}${CAMERA}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA;  // x, y, z, size
layout(location=2) in vec4 aB;  // rgba
layout(location=3) in vec4 aC;  // rotation, kind, aspect, param
out vec2 vQ; out vec4 vCol; out vec4 vC; out float vPx;
void main() {
  float k = aC.y;
  float ext = (k == 2.0 || k == 7.0 || k == 8.0 || k == 9.0) ? 1.05 : (k == 3.0 ? 1.15 : 3.2);
  vec2 q = (aCorner * 2.0 - 1.0) * ext;
  vec2 lq = q * vec2(1.0, (k == 3.0) ? aC.z : 1.0);
  vec2 w = aA.xy + rot2(lq * aA.w, aC.x);
  vQ = q; vCol = aB; vC = aC;
  vPx = pxAt(aA.z) / max(aA.w, 1e-5);
  gl_Position = project(vec3(w, aA.z));
}`;

export const PART_FS = `${HEADER}${CAMERA}${NOISE}
in vec2 vQ; in vec4 vCol; in vec4 vC; in float vPx;
out vec4 o;
void main() {
  float k = vC.y;
  vec2 q = vQ;
  float r2 = dot(q, q);
  if (k == 0.0) {                // glow dot: core + halo, additive
    float core = exp(-r2 * 3.0);
    float halo = exp(-r2 * 0.45) * 0.22;
    o = vec4(vCol.rgb * (core + halo) * vCol.a, 0.0);
  } else if (k == 1.0) {         // sparkle
    vec2 a = abs(q);
    float star = exp(-a.x * 6.0) * exp(-a.y * 0.9) + exp(-a.y * 6.0) * exp(-a.x * 0.9);
    vec2 d = abs(rot2(q, 0.785));
    star += 0.35 * (exp(-d.x * 9.0) * exp(-d.y * 1.8) + exp(-d.y * 9.0) * exp(-d.x * 1.8));
    float core = exp(-r2 * 6.0);
    o = vec4(vCol.rgb * (star * 0.8 + core) * vCol.a, 0.0);
  } else if (k == 2.0 || k == 8.0) {   // leaf / petal
    float w = (k == 2.0) ? 0.42 : 0.62;
    float ly = q.y;
    float half_ = w * sqrt(max(0.0, 1.0 - ly * ly)) * (k == 2.0 ? (1.0 - 0.25 * ly) : 1.0);
    float d = abs(q.x) - half_;
    float a = clamp(0.5 - d / (vPx * 1.5 + 0.02), 0.0, 1.0) * step(abs(ly), 1.0);
    if (a <= 0.0) discard;
    float rib = (k == 2.0) ? exp(-abs(q.x) / 0.05) * 0.25 : 0.0;
    vec3 col = vCol.rgb * (0.75 + 0.4 * (q.x + 0.5) * 0.6) + rib * vCol.rgb;
    col *= 0.85 + 0.3 * vC.w;     // param = sheen/turn
    o = vec4(col * a * vCol.a, a * vCol.a);
  } else if (k == 3.0) {          // ripple ring
    float rr = sqrt(r2);
    float line = exp(-pow((rr - 1.0) / (0.05 + vPx * 1.5), 2.0));
    o = vec4(vCol.rgb * line * vCol.a, 0.0);
  } else if (k == 4.0) {          // bokeh disc
    float rr = sqrt(r2) / 3.0 * 3.2;
    float disc = smoothstep(1.0, 0.86, rr) * (0.75 + 0.25 * smoothstep(0.6, 0.98, rr));
    o = vec4(vCol.rgb * disc * vCol.a, 0.0);
  } else if (k == 5.0) {          // fruit: lit sphere with an inner light
    float rr = sqrt(r2);
    float body = clamp(0.5 - (rr - 1.0) / (vPx * 1.5 + 0.01), 0.0, 1.0);
    vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r2)));
    float lam = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);
    float spec = pow(clamp(dot(reflect(-normalize(vec3(-0.4, 0.6, 0.7)), n), vec3(0, 0, 1)), 0.0, 1.0), 24.0);
    float inner = exp(-r2 * 1.6) * (0.8 + 0.4 * vC.w);
    float fres = pow(1.0 - n.z, 2.0);
    vec3 col = vCol.rgb * (0.35 + 0.65 * lam) * 0.9 + vCol.rgb * inner * 2.2 + vec3(1.0) * spec * 1.4 + vCol.rgb * fres * 1.2;
    float halo = exp(-max(rr - 1.0, 0.0) * 1.7) * (1.0 - body) * 0.9 * (0.6 + 0.4 * vC.w);
    o = vec4(col * body * vCol.a + vCol.rgb * halo * vCol.a, body * vCol.a);
  } else if (k == 6.0) {          // paper lantern; param = light (0 dark .. 1 lit)
    vec2 p = q;
    float body = length(p * vec2(1.0, 0.78)) - 0.95;
    float a = clamp(0.5 - body / (vPx * 1.5 + 0.01), 0.0, 1.0);
    float caps = step(abs(p.x), 0.42) * (step(0.62, p.y) * step(p.y, 0.92) + step(-0.92, p.y) * step(p.y, -0.66));
    float ribs = 0.5 + 0.5 * cos(p.y * 18.0);
    float lit = vC.w;
    vec3 paper = mix(vec3(0.16, 0.07, 0.05), vCol.rgb * (1.6 + 1.2 * (1.0 - r2)), lit);
    paper *= 0.82 + 0.18 * ribs;
    vec3 cap = vec3(0.06, 0.04, 0.03);
    vec3 col = mix(paper, cap, caps);
    float halo = exp(-max(sqrt(r2) - 0.9, 0.0) * 1.3) * (1.0 - a) * lit;
    o = vec4(col * a * vCol.a + vCol.rgb * halo * 0.9 * vCol.a, a * vCol.a);
  } else if (k == 7.0) {          // paper plane (top-down dart, nose to +x)
    vec2 p = q;
    float wing = step(-0.9, p.x) * step(p.x, 1.0) * step(abs(p.y), (1.0 - p.x) * 0.45);
    float fold = exp(-abs(p.y) / 0.035) * step(-0.9, p.x) * step(p.x, 1.0);
    float a = wing;
    if (a <= 0.0) discard;
    vec3 col = vCol.rgb * (0.82 + 0.25 * sign(p.y) * vC.w) - fold * 0.12;
    o = vec4(col * a * vCol.a, a * vCol.a);
  } else if (k == 9.0) {          // grass blade: base at q.y=-1, tip at +1
    float t = (q.y + 1.0) * 0.5;
    float half_ = vC.z * pow(max(1.0 - t, 0.0), 0.85);
    float d = abs(q.x) - half_;
    float a = clamp(0.5 - d / (vPx * 1.2 + 0.004), 0.0, 1.0) * step(-1.0, q.y) * step(q.y, 1.0);
    if (a <= 0.0) discard;
    vec3 col = vCol.rgb * (0.55 + 0.6 * t) * (0.9 + 0.2 * sign(q.x) * vC.w);
    o = vec4(col * a * vCol.a, a * vCol.a);
  } else {
    discard;
  }
}`;

export const RIBBON_VS = `${HEADER}${CAMERA}
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aUV;   // u across (-1..1), v along (world), core, alpha
layout(location=2) in vec4 aCol;
out vec4 vUV; out vec4 vCol;
void main() { vUV = aUV; vCol = aCol; gl_Position = project(aPos); }`;

export const RIBBON_FS = `${HEADER}${CAMERA}
in vec4 vUV; in vec4 vCol;
uniform float uPulseFreq, uPulseSpeed, uPulseAmt, uPremul;
out vec4 o;
void main() {
  float u = vUV.x;
  float core = exp(-u * u * 7.0) * vUV.z + exp(-u * u * 1.6) * 0.3;
  float pulse = 1.0 + uPulseAmt * pow(0.5 + 0.5 * sin(vUV.y * uPulseFreq - uTime * uPulseSpeed), 6.0);
  vec3 c = vCol.rgb * core * pulse * vUV.w;
  if (uPremul > 0.5) {
    float a = clamp(exp(-u * u * 4.0) * vUV.w * vCol.a, 0.0, 1.0);
    o = vec4(c, a);
  } else {
    o = vec4(c * vCol.a, 0.0);
  }
}`;

export const TEXT_VS = `${HEADER}
layout(location=0) in vec2 aCorner;
uniform vec4 uRect;   // px left, bottom, width, height
uniform vec2 uRes;
out vec2 vUV; out float vX;
void main() {
  vec2 p = uRect.xy + aCorner * uRect.zw;
  vUV = vec2(aCorner.x, 1.0 - aCorner.y);
  vX = aCorner.x;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

export const TEXT_FS = `${HEADER}
in vec2 vUV; in float vX;
uniform sampler2D uTex;
uniform float uAlpha, uReveal, uBlur, uSoft;
uniform vec3 uTint;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUV, uBlur);
  float m = 1.0 - smoothstep(uReveal - uSoft, uReveal, vX);
  float a = c.a * uAlpha * m;
  o = vec4(uTint * (c.rgb / max(c.a, 1e-4)) * a, a);
}`;

// Trunk cross-section. Inscriptions come from a texture: row k = ring k's text,
// u = position around the ring.
export const RINGS_FS = `${HEADER}${CAMERA}${NOISE}
uniform vec2 uCenter;      // screen px
uniform float uScale;      // px per ring unit
uniform float uLit;        // rings lit so far (fractional)
uniform float uAmt, uSpin, uRings;
uniform sampler2D uText; uniform float uTextRows;
uniform vec3 uWood, uLate, uGlow, uGlow2;
out vec4 o;
void main() {
  vec2 p = (gl_FragCoord.xy - uCenter) / uScale;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float wob = 0.12 * fbm(vec2(ang * 2.0, 1.0)) + 0.05 * sin(ang * 3.0 + 1.0);
  float rr = r + wob;
  float k = floor(rr);
  float f = fract(rr);
  float edgeR = uRings + 0.5 + 0.15 * sin(ang * 5.0);
  float disc = smoothstep(edgeR + 0.04, edgeR - 0.04, rr);
  if (disc <= 0.0 || uAmt <= 0.0) discard;
  // earlywood → latewood inside each ring
  float late = smoothstep(0.7, 0.96, f) * (1.0 - smoothstep(0.96, 1.0, f));
  vec3 col = mix(uWood, uLate, late * 0.85);
  col *= 0.85 + 0.3 * fbm(vec2(r * 6.0, ang * 30.0));
  float rays = smoothstep(0.985, 1.0, sin(ang * 90.0 + fbm(vec2(r, 0.0)) * 8.0));
  col *= 1.0 - rays * 0.25;
  col = mix(col, vec3(0.05, 0.03, 0.02), smoothstep(edgeR - 0.35, edgeR, rr)); // bark
  // lit rings glow
  float litK = step(k + 1.0, uLit + 0.001);
  float fresh = exp(-max(uLit - (k + 1.0), 0.0) * 1.8) * litK;
  float line = exp(-pow((f - 0.86) / 0.05, 2.0));
  vec3 g = mix(uGlow, uGlow2, 0.5 + 0.5 * sin(k * 1.7));
  col += g * line * litK * (0.8 + 2.2 * fresh);
  col += g * 0.08 * litK;
  // inscription on lit rings
  if (litK > 0.0 && k < uTextRows && k >= 1.0) {
    float band = smoothstep(0.18, 0.26, f) * (1.0 - smoothstep(0.66, 0.74, f));
    float u = fract(-ang / 6.28318 + uSpin * (0.3 + 0.1 * k) + 0.25);
    float v = (k + 1.0 - (f - 0.2) / 0.5) / uTextRows;   // outward = up in the row
    vec4 tx = texture(uText, vec2(u, clamp(v, (k) / uTextRows, (k + 1.0) / uTextRows)));
    col += g * tx.a * band * (1.2 + 1.5 * fresh);
  }
  float centre = exp(-r * r * 3.0);
  col += uGlow * centre * 0.6 * step(0.001, uLit);
  o = vec4(col * disc * uAmt, disc * uAmt);
}`;
