// Branches (bark / luminous roots) and metaball foliage.
import { HEADER, CAMERA, NOISE } from './common.js';

export const BRANCH_VS = `${HEADER}${CAMERA}
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aUVR;   // u across, v along, radius, order
layout(location=2) in vec4 aExtra; // rand, glow, normal.xy
out vec2 vW; out float vU; out float vV; out float vR; out float vOrder; out float vRand; out float vGlow; out vec2 vN;
void main() {
  vW = aPos.xy; vU = aUVR.x; vV = aUVR.y; vR = aUVR.z; vOrder = aUVR.w;
  vRand = aExtra.x; vGlow = aExtra.y; vN = aExtra.zw;
  gl_Position = project(aPos);
}`;

export const BRANCH_FS = `${HEADER}${CAMERA}${NOISE}
in vec2 vW; in float vU; in float vV; in float vR; in float vOrder; in float vRand; in float vGlow; in vec2 vN;
uniform vec3 uBark, uBarkDark, uBarkLit, uKeyCol, uAmbient, uRimCol;
uniform vec2 uKeyDir;
uniform vec3 uGlowA, uGlowB, uGlowC;
uniform float uBraid, uFlow, uPx, uKind, uEmis, uVeins, uFade, uYoung;
uniform vec4 uPt0; uniform vec3 uPt0Col;
uniform vec4 uPt1; uniform vec3 uPt1Col;
out vec4 o;
void main() {
  float r = max(vR, 1e-5);
  float d = abs(vU) * (r + uPx * 1.5);
  float cov = clamp((r - d) / uPx + 0.5, 0.0, 1.0);
  cov *= clamp(r * 2.2 / uPx, 0.12, 1.0);
  if (cov <= 0.002) discard;
  float u = clamp(d / r, 0.0, 1.0) * sign(vU);
  float nz = sqrt(max(0.0, 1.0 - u * u));
  vec2 n2 = normalize(vN + 1e-6);
  vec3 N = normalize(vec3(n2 * u, nz));
  vec3 L = normalize(vec3(uKeyDir, 0.55));
  float diff = clamp(dot(N, L) * 0.62 + 0.38, 0.0, 1.0);

  float detail = 1.0 - smoothstep(0.06, 0.35, uPx);
  vec2 bp = vec2(u * r * 1.8 + vRand * 23.0, vV * 0.75);
  float fiss = mix(0.55, fbm(bp), detail);
  float ridge = smoothstep(0.38, 0.72, fiss);
  vec3 albedo = mix(uBarkDark, uBark, ridge);
  albedo = mix(albedo, uBarkLit, smoothstep(0.62, 0.9, fiss) * 0.45);
  albedo = mix(mix(vec3(0.05, 0.16, 0.03), vec3(0.16, 0.34, 0.07), 0.5 + 0.5 * u), albedo, mix(1.0, smoothstep(0.012, 0.07, r), uYoung));
  albedo *= mix(1.0, 0.72, smoothstep(0.55, 1.0, abs(u)));   // edges fall off

  vec3 col = albedo * (uAmbient + uKeyCol * diff);
  float rim = pow(1.0 - nz, 2.5) * max(dot(n2 * sign(u), normalize(uKeyDir + 1e-6)), 0.0);
  col += uRimCol * rim * (0.6 + 0.4 * ridge);
  float d0 = length(vW - uPt0.xy) / max(uPt0.z, 1e-3);
  col += albedo * uPt0Col * uPt0.w * exp(-d0 * d0) * (0.5 + 0.5 * diff);
  float d1 = length(vW - uPt1.xy) / max(uPt1.z, 1e-3);
  col += albedo * uPt1Col * uPt1.w * exp(-d1 * d1) * (0.5 + 0.5 * diff);

  // luminous flow: a braid of three strands (one per cat) or a single glow
  if (vGlow > 0.001) {
    float pulse = pow(0.5 + 0.5 * sin(vV * 0.85 - uTime * uFlow), 5.0);
    float w = 0.28;
    float s0 = exp(-pow((u - 0.55 * sin(vV * 0.6)) / w, 2.0));
    float s1 = exp(-pow((u - 0.55 * sin(vV * 0.6 + 2.094)) / w, 2.0));
    float s2 = exp(-pow((u - 0.55 * sin(vV * 0.6 + 4.189)) / w, 2.0));
    vec3 braid = uGlowA * s0 + uGlowB * s1 + uGlowC * s2;
    vec3 single = mix(uGlowA, uGlowB, 0.5 + 0.5 * sin(vV * 0.07 + vRand * 6.0)) * (0.4 + 0.6 * nz);
    vec3 gcol = mix(single, braid * 1.3, uBraid);
    col += gcol * vGlow * (0.45 + 1.4 * pulse) * uEmis;
  }
  // veins of light rising in the bark (after the roots connect)
  if (uVeins > 0.0 && uKind < 0.5) {
    float vein = smoothstep(0.62, 0.66, fbm(vec2(u * r * 0.9 + vRand * 5.0, vV * 0.18))) * detail;
    float rise = pow(0.5 + 0.5 * sin(vV * 0.5 - uTime * 2.4), 4.0);
    col += mix(uGlowA, uGlowC, 0.5 + 0.5 * sin(vV * 0.1)) * vein * uVeins * (0.3 + rise);
  }
  o = vec4(col * cov * uFade, cov * uFade);
}`;

export const CANOPY_DENSITY_VS = `${HEADER}${CAMERA}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA; // x, y, r, z
layout(location=2) in vec4 aB; // exposure, hue, blossom, alpha
out vec2 vQ; out vec4 vB;
void main() {
  vec2 q = aCorner * 2.0 - 1.0;
  vQ = q * 1.7;
  vB = aB;
  gl_Position = project(vec3(aA.xy + q * aA.z * 1.7, aA.w));
}`;

export const CANOPY_DENSITY_FS = `${HEADER}
in vec2 vQ; in vec4 vB;
out vec4 o;
void main() {
  float g = exp(-dot(vQ, vQ) * 2.3) * vB.w;
  if (g < 0.002) discard;
  o = vec4(g, g * vB.x, g * vB.y, g * vB.z);
}`;

export const CANOPY_SHADE_FS = `${HEADER}${CAMERA}${NOISE}
uniform sampler2D uDensity;
uniform vec3 uLit, uMid, uShadow, uRim;       // palette A
uniform vec3 uLit2, uMid2, uShadow2, uRim2;   // palette B
uniform vec2 uFlipC; uniform float uFlipR;     // palette B inside radius
uniform vec2 uKeyDir; uniform vec3 uKeyCol, uAmbient;
uniform float uThresh, uBacklit, uPx, uLeaf, uBlossom, uLeafScale, uFade;
uniform vec3 uBlossomCol, uBlossomCol2;
uniform vec4 uPt0; uniform vec3 uPt0Col;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 D = texture(uDensity, uv);
  float dens = D.r;
  if (dens < 0.04) discard;
  vec2 tx = 2.0 / uRes;
  float dl = texture(uDensity, uv - vec2(tx.x, 0.0)).r;
  float dr = texture(uDensity, uv + vec2(tx.x, 0.0)).r;
  float dd = texture(uDensity, uv - vec2(0.0, tx.y)).r;
  float du = texture(uDensity, uv + vec2(0.0, tx.y)).r;
  vec2 grad = vec2(dr - dl, du - dd) / (4.0 * uPx);   // per world unit

  vec2 p = unproject(gl_FragCoord.xy, 0.0);
  float detail = 1.0 - smoothstep(0.08, 0.3, uPx * uLeafScale);
  vec2 vor = voronoi(p * uLeafScale);
  float n = fbm3(p * 0.35);
  float thr = uThresh + (n - 0.5) * 0.22 + (vor.x - 0.45) * 0.28 * detail;
  float aa = 0.02 + uPx * 0.6 * length(grad) + 0.01;
  float a = smoothstep(thr - aa, thr + aa, dens);
  if (a <= 0.002) discard;

  float expo = clamp(D.g / max(dens, 1e-4), 0.0, 1.0);
  float hue = clamp(D.b / max(dens, 1e-4), 0.0, 1.0);
  vec3 N = normalize(vec3(-grad * 1.4, 1.0));
  vec3 L = normalize(vec3(uKeyDir, 0.7));
  float lam = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float lit = clamp(lam * (0.35 + 0.8 * expo), 0.0, 1.0);

  float flip = smoothstep(uFlipR + 2.5, uFlipR - 2.5, length(p - uFlipC));
  vec3 cS = mix(uShadow, uShadow2, flip), cM = mix(uMid, uMid2, flip), cL = mix(uLit, uLit2, flip), cR = mix(uRim, uRim2, flip);
  vec3 col = mix(cS, cM, smoothstep(0.15, 0.55, lit));
  col = mix(col, cL, smoothstep(0.55, 0.95, lit));
  col *= 0.88 + 0.24 * hue;
  // leaf cells: darker gaps between leaves, lighter leaf centres
  col *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 0.08, vor.y)) * detail;
  col *= 1.0 + 0.12 * (1.0 - vor.x) * detail;
  col *= uAmbient + uKeyCol;
  // rim where the edge faces the light, glow through thin edges when backlit
  float edge = 1.0 - smoothstep(thr, thr + 0.35, dens);
  float facing = max(dot(normalize(-grad + 1e-6), normalize(uKeyDir + 1e-6)), 0.0);
  col += cR * edge * facing * 0.9;
  col += cR * edge * uBacklit * 1.4;
  float d0 = length(p - uPt0.xy) / max(uPt0.z, 1e-3);
  col += cM * uPt0Col * uPt0.w * exp(-d0 * d0);
  // blossoms: glowing points living in the leaf cells
  float bl = clamp(D.a / max(dens, 1e-4), 0.0, 1.0) * uBlossom;
  if (bl > 0.0) {
    vec2 cell = floor(p * uLeafScale * 0.5);
    float hsh = hash12(cell * 1.7 + 3.0);
    vec2 cp = (cell + 0.25 + 0.5 * hash22(cell)) / (uLeafScale * 0.5);
    float on = step(1.0 - bl * 0.55, hsh);
    float sz = 0.1 + uPx * 1.6;
    float dot0 = exp(-dot(p - cp, p - cp) / (sz * sz));
    float tw = 0.6 + 0.4 * sin(uTime * (1.5 + 3.0 * hsh) + hsh * 40.0);
    col += mix(uBlossomCol, uBlossomCol2, fract(hsh * 7.3)) * dot0 * on * tw * 4.0;
    col += uBlossomCol * bl * 0.12;
  }
  o = vec4(col * a * uFade, a * uFade);
}`;
