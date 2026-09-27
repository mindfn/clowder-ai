// Cats (canon sprites lit into the scene), the person (SDF), glass cases and shards.
import { HEADER, CAMERA, NOISE } from './common.js';

export const SPRITE_VS = `${HEADER}${CAMERA}
layout(location=0) in vec2 aCorner;
uniform vec4 uQuad;   // world left, bottom, width, height
uniform vec4 uXf;     // pivot x, pivot y, rotation, unused
uniform vec2 uSquash;
uniform float uZ, uFlip;
out vec2 vUV; out vec2 vW;
void main() {
  vec2 w = uQuad.xy + aCorner * uQuad.zw;
  vec2 rel = rot2((w - uXf.xy) * uSquash, uXf.z);
  w = uXf.xy + rel;
  vW = w;
  vUV = vec2(uFlip > 0.5 ? 1.0 - aCorner.x : aCorner.x, 1.0 - aCorner.y);
  gl_Position = project(vec3(w, uZ));
}`;

export const SPRITE_FS = `${HEADER}${CAMERA}
in vec2 vUV; in vec2 vW;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec3 uAmbient, uKeyCol, uRimCol, uSilCol;
uniform vec2 uKeyDirUV;
uniform float uRimW, uAlpha, uSil, uLod, uGlowRim;
uniform vec4 uPt0; uniform vec3 uPt0Col;
uniform vec4 uPt1; uniform vec3 uPt1Col;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUV, uLod);   // uLod is a bias on top of the hardware LOD
  if (c.a < 0.004) discard;
  vec3 lin = pow(c.rgb / c.a, vec3(2.2));
  float ao = texture(uTex, vUV + uKeyDirUV * uRimW * uTexel, uLod).a;
  float ao2 = texture(uTex, vUV + uKeyDirUV * uRimW * 2.5 * uTexel, uLod + 1.0).a;
  float rim = c.a * clamp(1.0 - 0.6 * ao - 0.4 * ao2, 0.0, 1.0);
  vec3 col = lin * (uAmbient + uKeyCol);
  col += uRimCol * rim * (0.35 + 0.65 * dot(lin, vec3(0.33)));
  float d0 = length(vW - uPt0.xy) / max(uPt0.z, 1e-3);
  float f0 = uPt0.w * exp(-d0 * d0);
  float d1 = length(vW - uPt1.xy) / max(uPt1.z, 1e-3);
  float f1 = uPt1.w * exp(-d1 * d1);
  col += lin * (uPt0Col * f0 + uPt1Col * f1);
  // a glowing outline for night shots / moments of emphasis
  float edge = c.a * (1.0 - texture(uTex, vUV, uLod + 2.0).a * 0.9);
  col += (uPt0Col * f0 + uRimCol) * edge * uGlowRim;
  col = mix(col, uSilCol + uRimCol * rim * 1.5, uSil);
  o = vec4(col * c.a * uAlpha, c.a * uAlpha);
}`;

export const HUMAN_VS = `${HEADER}${CAMERA}
layout(location=0) in vec2 aCorner;
uniform vec4 uBox;   // world left, bottom, width, height
uniform float uZ;
out vec2 vW;
void main() {
  vW = uBox.xy + aCorner * uBox.zw;
  gl_Position = project(vec3(vW, uZ));
}`;

export const HUMAN_FS = `${HEADER}${CAMERA}
in vec2 vW;
uniform vec4 uSeg[16];     // capsule a.xy, b.xy
uniform vec2 uSegR[16];    // radius at a, radius at b
uniform int uSegN;
uniform vec4 uHead;        // centre xy, radius, hair tilt
uniform vec3 uBody, uRimCol, uWarm;
uniform vec2 uKeyDir;
uniform float uAlpha, uZ, uRimW;
uniform vec4 uPt0; uniform vec3 uPt0Col;
out vec4 o;
float sdUneven(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
  p -= pa; pb -= pa;
  float h = dot(pb, pb);
  if (h < 1e-8) return length(p) - ra;
  vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
  q.x = abs(q.x);
  float b = ra - rb;
  vec2 c = vec2(sqrt(max(h - b * b, 1e-8)), b);
  float k = c.x * q.y - c.y * q.x;
  float m = dot(c, q);
  float n = dot(q, q);
  if (k < 0.0) return sqrt(h * n) - ra;
  if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
  return m - ra;
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdf(vec2 p) {
  float d = length((p - uHead.xy) * vec2(1.0, 0.92)) - uHead.z;
  // hair: a bun high behind the head and a soft fringe over the brow
  d = smin(d, length(p - uHead.xy - vec2(-uHead.z * 0.95 * uHead.w, uHead.z * 0.55)) - uHead.z * 0.5, uHead.z * 0.3);
  d = smin(d, length((p - uHead.xy - vec2(-uHead.z * 0.2 * uHead.w, uHead.z * 0.45)) * vec2(0.8, 1.4)) - uHead.z * 0.75, uHead.z * 0.2);
  for (int i = 0; i < 16; i++) {
    if (i >= uSegN) break;
    d = smin(d, sdUneven(p, uSeg[i].xy, uSeg[i].zw, uSegR[i].x, uSegR[i].y), 0.06);
  }
  return d;
}
void main() {
  float px = pxAt(uZ);
  float d = sdf(vW);
  float a = clamp(0.5 - d / px, 0.0, 1.0);
  if (a <= 0.002) discard;
  vec2 e = vec2(px, 0.0);
  vec2 g = normalize(vec2(sdf(vW + e.xy) - sdf(vW - e.xy), sdf(vW + e.yx) - sdf(vW - e.yx)) + 1e-6);
  float band = smoothstep(-uRimW - px, -px * 0.5, d);
  float rim = band * max(dot(g, normalize(uKeyDir + 1e-6)), 0.0);
  vec3 col = uBody + uRimCol * rim * 0.55;
  float d0 = length(vW - uPt0.xy) / max(uPt0.z, 1e-3);
  float f0 = uPt0.w * exp(-d0 * d0);
  float facing = pow(max(dot(g, normalize(uPt0.xy - vW + 1e-6)), 0.0), 1.5);
  float soft = smoothstep(-uRimW * 2.5 - px, -px * 0.5, d);
  col += uPt0Col * f0 * (band * 0.8 + soft * 0.35) * facing;
  col += uPt0Col * f0 * 0.012;
  col += uWarm * band * 0.15;
  o = vec4(col * a * uAlpha, a * uAlpha);
}`;

export const GLASS_VS = `${HEADER}${CAMERA}
layout(location=0) in vec2 aCorner;
uniform vec4 uBox;   // centre x, y, half w, half h
uniform float uZ;
out vec2 vW;
void main() {
  vec2 q = aCorner * 2.0 - 1.0;
  vW = uBox.xy + q * (uBox.zw + 0.35);
  gl_Position = project(vec3(vW, uZ));
}`;

export const GLASS_FS = `${HEADER}${CAMERA}${NOISE}
in vec2 vW;
uniform vec4 uBox;
uniform float uZ, uCorner, uAppear, uCrack, uFog, uAlpha, uSeed, uFlash;
uniform vec2 uImpact;
uniform vec3 uTint, uEdgeCol, uCrackCol;
out vec4 o;
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  float px = pxAt(uZ);
  vec2 p = vW - uBox.xy;
  float d = sdRoundBox(p, uBox.zw, uCorner);
  float inside = smoothstep(px, -px, d);
  // materialise upward with a shimmering front
  float yN = (p.y + uBox.w) / (2.0 * uBox.w);
  float front = uAppear * 1.2 - 0.1;
  float shown = smoothstep(front + 0.04, front - 0.04, yN);
  float frontGlow = exp(-pow((yN - front) / 0.03, 2.0)) * step(0.001, uAppear) * (1.0 - step(0.999, uAppear));
  float edge = 0.55 * exp(-abs(d) / (px * 1.2 + 0.012)) + 0.12 * exp(-abs(d) / (px * 4.0 + 0.06));
  float inner = exp(-abs(d + 0.09) / (px * 1.0 + 0.01)) * 0.22;
  float streak = smoothstep(0.86, 1.0, sin((p.x * 0.8 + p.y * 1.3) * 2.2 + uSeed)) * 0.5 + smoothstep(0.95, 1.0, sin((p.x * 0.8 + p.y * 1.3) * 5.1 + uSeed * 2.0)) * 0.35;
  vec3 col = uTint * 0.05 * inside + uEdgeCol * (edge + inner) + uEdgeCol * streak * inside * 0.35;
  float alpha = inside * 0.10 + (edge + inner) * 0.6 + streak * inside * 0.08;
  // condensation: the case fogs up as frustration grows
  float fog = uFog * inside * (0.55 + 0.45 * fbm(vW * 2.5 + uSeed));
  col += vec3(0.75, 0.82, 0.9) * fog * 0.18;
  alpha += fog * 0.22;
  // cracks: cellular edges within a growing radius, plus radial splits
  if (uCrack > 0.0) {
    vec2 r = vW - uImpact;
    float rr = length(r);
    vec2 vor = voronoi(r * 1.6 + uSeed);
    float cell = 1.0 - smoothstep(0.0, px * 2.5 + 0.012, vor.y);
    float ang = atan(r.y, r.x);
    float spokes = 1.0 - smoothstep(0.0, 0.035 + px * 0.6, abs(sin(ang * 7.0 + fbm(vec2(rr * 1.5, uSeed)) * 1.2)) * rr);
    float within = smoothstep(uCrack, uCrack * 0.85, rr);
    float c = max(cell * smoothstep(0.08, 0.3, rr), spokes) * within * inside;
    col += uCrackCol * c * 2.2;
    alpha += c * 0.8;
  }
  col += uEdgeCol * frontGlow * inside * 3.0;
  col += vec3(1.0) * uFlash * inside;
  alpha = clamp(alpha, 0.0, 1.0) * shown * uAlpha;
  o = vec4(col * shown * uAlpha, alpha);
}`;

// Shards: per-vertex world pos + (local u,v in shard, glint, alpha)
export const SHARD_VS = `${HEADER}${CAMERA}
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aInfo; // glint, alpha, edge (0 centre .. 1 rim), seed
out vec4 vInfo;
void main() { vInfo = aInfo; gl_Position = project(aPos); }`;

export const SHARD_FS = `${HEADER}
in vec4 vInfo;
uniform vec3 uEdgeCol, uGlintCol;
out vec4 o;
void main() {
  float e = smoothstep(0.7, 1.0, vInfo.z);
  vec3 col = uEdgeCol * (0.12 + e * 0.9) + uGlintCol * vInfo.x;
  float a = (0.14 + e * 0.5 + vInfo.x * 0.4) * vInfo.y;
  o = vec4(col * vInfo.y, clamp(a, 0.0, 1.0));
}`;
