// Sky, distant ridges and the soil cross-section.
import { HEADER, CAMERA, NOISE } from './common.js';

export const FULL_VS = `${HEADER}
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const SKY_FS = `${HEADER}${CAMERA}${NOISE}
uniform vec3 uZenith, uMid, uHorizon;
uniform float uHorizonY;      // horizon line, pixels from bottom
uniform vec4 uSun;            // px x, px y, disc radius px, intensity
uniform vec3 uSunColor;
uniform vec4 uMoon;           // px x, px y, radius px, intensity
uniform float uStars, uMilky, uAurora, uClouds;
uniform vec3 uCloudLit, uCloudShade;
uniform float uCloudTime;
out vec4 o;

float starLayer(vec2 p, float cell, float pxw, float seed) {
  vec2 id = floor(p / cell);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = id + vec2(float(i), float(j));
    vec2 h = hash22(c + seed);
    vec2 sp = (c + h) * cell;
    float b = pow(hash12(c * 1.37 + seed), 14.0) * 5.0 + 0.12 * hash12(c + 3.1);
    float sz = (0.55 + 1.6 * sqrt(b)) * pxw;
    float d = length(p - sp);
    float tw = 0.65 + 0.35 * sin(uTime * (1.3 + 3.0 * h.x) + 6.28 * h.y);
    acc += b * tw * exp(-d * d / (sz * sz));
    // glints on the brightest
    vec2 q = abs(p - sp);
    acc += step(1.6, b) * b * 0.25 * tw * (exp(-q.x / (0.5 * pxw)) * exp(-q.y / (5.0 * pxw)) + exp(-q.y / (0.5 * pxw)) * exp(-q.x / (5.0 * pxw)));
  }
  return acc;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float h = (fc.y - uHorizonY) / uRes.y;
  vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.32, h));
  col = mix(col, uZenith, smoothstep(0.22, 0.95, h));

  vec2 p = unproject(fc, -3000.0);
  float pxw = pxAt(-3000.0);
  float above = smoothstep(-0.02, 0.12, h);

  // milky way: a tilted band with dust lanes
  if (uMilky > 0.0) {
    vec2 q = rot2(p, 0.55) * 0.0022;
    float band = exp(-pow((q.y - 0.35 + 0.25 * fbm(vec2(q.x * 0.7, 1.0))) / 0.55, 2.0));
    float dust = fbm(q * 3.0 + vec2(4.0, 1.0));
    float neb = fbm(q * 6.0);
    float mw = band * (0.55 + 0.9 * neb) * smoothstep(0.35, 0.75, 1.0 - dust * 0.9);
    col += vec3(0.55, 0.62, 0.95) * mw * 0.10 * uMilky * above;
    col += vec3(0.95, 0.75, 0.6) * pow(band, 3.0) * neb * 0.06 * uMilky * above;
  }
  // stars
  if (uStars > 0.0) {
    float s = starLayer(p, 36.0 * pxw / 1.8, pxw, 0.0) + 0.6 * starLayer(p, 15.0 * pxw / 1.8, pxw * 0.8, 7.0);
    col += vec3(0.85, 0.9, 1.0) * s * uStars * above;
  }
  // aurora curtains
  if (uAurora > 0.0) {
    vec2 q = p * 0.0011;
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float x = q.x * (1.0 + 0.35 * fk) + fk * 3.7;
      float wave = fbm(vec2(x * 0.6 + uTime * 0.03, fk)) * 1.4;
      float base = 0.12 + 0.11 * fk + 0.12 * wave;
      float hh = h - base;
      float curtain = smoothstep(-0.015, 0.02, hh) * exp(-max(hh, 0.0) / (0.10 + 0.05 * fk));
      float rays = 0.45 + 0.55 * vnoise(vec2(x * 28.0 + uTime * 0.25, fk * 3.0));
      rays *= 0.6 + 0.4 * vnoise(vec2(x * 7.0 - uTime * 0.1, 9.0 + fk));
      vec3 c = mix(vec3(0.15, 1.0, 0.55), vec3(0.35, 0.55, 1.0), smoothstep(0.0, 0.18, hh));
      c = mix(c, vec3(0.85, 0.35, 0.95), smoothstep(0.12, 0.3, hh));
      acc += c * curtain * rays * (0.7 - 0.15 * fk);
    }
    col += acc * uAurora * 0.55 * above;
  }
  // clouds (their own plane, more parallax than the stars)
  if (uClouds > 0.0) {
    vec2 cp = unproject(fc, -1400.0) * 0.0036 + vec2(uCloudTime * 0.02, 0.0);
    float band = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.35, 0.7, h));
    float dn = fbm(cp) - 0.42;
    float d = smoothstep(0.0, 0.28, dn) * band;
    vec2 sdir = normalize(uSun.xy - fc + 1e-3);
    float dl = fbm(cp + sdir * 0.05) - 0.42;
    float lit = clamp((dn - dl) * 6.0 + 0.45, 0.0, 1.0);
    vec3 cc = mix(uCloudShade, uCloudLit, lit);
    col = mix(col, cc, d * uClouds);
  }
  // sun
  float ds = length(fc - uSun.xy) / uRes.y;
  col += uSunColor * uSun.w * (0.55 * exp(-ds * 7.0) + 0.25 * exp(-ds * 2.0) + 0.08 * exp(-ds * 0.6));
  col += uSunColor * uSun.w * 7.0 * smoothstep(uSun.z, uSun.z - 1.5, length(fc - uSun.xy));
  // moon
  if (uMoon.w > 0.0) {
    float dm = length(fc - uMoon.xy);
    float disc = smoothstep(uMoon.z, uMoon.z - 1.5, dm);
    vec2 mq = (fc - uMoon.xy) / uMoon.z;
    float mare = fbm(mq * 2.2 + 3.0);
    col += vec3(0.95, 0.93, 0.85) * disc * uMoon.w * (1.6 - 0.7 * mare);
    col += vec3(0.55, 0.65, 0.9) * uMoon.w * 0.25 * exp(-dm / (uMoon.z * 3.5));
  }
  o = vec4(col, 1.0);
}`;

export const RIDGE_FS = `${HEADER}${CAMERA}${NOISE}
uniform float uZ, uBase, uAmp, uFreq, uSeed, uTreeAmp, uTreeFreq, uAlpha, uRim;
uniform vec3 uColTop, uColBot, uRimCol;
uniform vec3 uLightCol; uniform float uLights; // sparse glowing windows/trees on the ridge
out vec4 o;
float ridgeH(float x) {
  float h = uBase + uAmp * (fbm(vec2(x * uFreq + uSeed, uSeed * 1.7)) - 0.5) * 2.2;
  float t = vnoise(vec2(x * uTreeFreq, uSeed * 3.0));
  h += uTreeAmp * (pow(t, 1.6) + 0.45 * vnoise(vec2(x * uTreeFreq * 3.3, uSeed)));
  return h;
}
void main() {
  vec2 p = unproject(gl_FragCoord.xy, uZ);
  float px = pxAt(uZ);
  float h = ridgeH(p.x);
  float a = smoothstep(h + px, h - px, p.y);
  if (a <= 0.001) discard;
  float depth = clamp((h - p.y) / (abs(uAmp) * 3.0 + 30.0), 0.0, 1.0);
  vec3 col = mix(uColTop, uColBot, sqrt(depth));
  col += uRimCol * uRim * exp(-(h - p.y) / (px * 2.5 + 0.4));
  if (uLights > 0.0) {
    vec2 cell = vec2(22.0, 9.0);
    vec2 id = floor(p / cell);
    vec2 hsh = hash22(id + uSeed);
    vec2 lp = (id + 0.2 + 0.6 * hsh) * cell;
    float on = step(0.72, hash12(id * 3.1 + uSeed)) * step(p.y, h - 2.0);
    float d = length(p - lp) / (px * 2.2 + 0.6);
    float tw = 0.7 + 0.3 * sin(uTime * (1.0 + 2.0 * hsh.x) + 6.28 * hsh.y);
    col += uLightCol * on * exp(-d * d) * uLights * tw;
  }
  o = vec4(col * a * uAlpha, a * uAlpha);
}`;

export const GROUND_FS = `${HEADER}${CAMERA}${NOISE}
uniform vec3 uSoilTop, uSoilDeep, uEdge, uAmbient;
uniform float uStrata;
uniform vec4 uGlow0; uniform vec3 uGlow0Col;   // world x,y, radius, intensity
uniform vec4 uGlow1; uniform vec3 uGlow1Col;
uniform vec4 uGlow2; uniform vec3 uGlow2Col;
uniform sampler2D uLightTex; uniform float uLightAmt;
uniform float uRipple; uniform vec2 uRippleC; uniform float uRippleR; uniform vec3 uRippleCol;
uniform float uCut;   // brightness of the cutaway face (0 = plain dark ground)
out vec4 o;
void main() {
  vec2 p = unproject(gl_FragCoord.xy, 0.0);
  float px = pxAt(0.0);
  float s = hill(p.x);
  float a = smoothstep(s + px, s - px, p.y);
  if (a <= 0.001) discard;
  float dd = s - p.y;
  vec3 col = mix(uSoilTop, uSoilDeep, smoothstep(0.0, 14.0, dd));
  float warp = fbm(p * 0.07) * 7.0;
  float strata = 0.5 + 0.5 * sin((p.y + warp) * 1.15);
  col *= 1.0 + uStrata * (strata - 0.5) * 0.35;
  float grain = fbm(p * 1.6);
  col *= 0.78 + 0.45 * grain;
  vec2 vor = voronoi(p * 1.25 + 7.0);
  float peb = (1.0 - smoothstep(0.18, 0.32, vor.x)) * step(0.82, hash12(floor(p * 1.25 + 7.0)));
  col = mix(col, col * 1.9 + 0.012, peb * 0.5 * smoothstep(0.3, 2.5, dd));
  col *= uCut;
  // lip of the cut catching the sky
  col += uEdge * exp(-dd / (px * 2.0 + 0.04)) + uEdge * 0.25 * exp(-dd / 0.6);
  // point lights (seed, fruit, lantern)
  vec3 albedo = mix(vec3(0.35, 0.26, 0.2), vec3(0.2, 0.16, 0.16), smoothstep(0.0, 10.0, dd));
  vec3 lit = vec3(0.0);
  float d0 = length(p - uGlow0.xy) / max(uGlow0.z, 1e-3);
  lit += uGlow0Col * uGlow0.w * exp(-d0 * d0);
  float d1 = length(p - uGlow1.xy) / max(uGlow1.z, 1e-3);
  lit += uGlow1Col * uGlow1.w * exp(-d1 * d1);
  float d2 = length(p - uGlow2.xy) / max(uGlow2.z, 1e-3);
  lit += uGlow2Col * uGlow2.w * exp(-d2 * d2);
  if (uLightAmt > 0.0) lit += texture(uLightTex, gl_FragCoord.xy / uRes).rgb * uLightAmt;
  col += albedo * lit * (0.6 + 0.8 * grain);
  // ripple of light through the soil
  if (uRipple > 0.0) {
    float rd = length((p - uRippleC) * vec2(1.0, 1.6));
    float ring = exp(-pow((rd - uRippleR) / (0.35 + 0.08 * uRippleR), 2.0));
    col += uRippleCol * ring * uRipple * (0.4 + 0.6 * strata) * exp(-uRippleR * 0.08);
  }
  col += uAmbient * albedo;
  o = vec4(col * a, a);
}`;
