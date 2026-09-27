// Pyramid blur (variable radius DOF + bloom), god rays, final grade.
import { HEADER, NOISE } from './common.js';

export const DOWN_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uTex; uniform vec2 uTexel;
out vec4 o;
void main() {
  vec2 h = uTexel * 0.5;
  vec4 s = texture(uTex, vUV) * 4.0;
  s += texture(uTex, vUV - h) + texture(uTex, vUV + h);
  s += texture(uTex, vUV + vec2(h.x, -h.y)) + texture(uTex, vUV - vec2(h.x, -h.y));
  o = s / 8.0;
}`;

// out = add ? base*baseW + up(coarse) : mix(base, up(coarse), w)
export const UP_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uTex, uBase; uniform vec2 uTexel;
uniform float uW, uAdd, uBaseW;
out vec4 o;
void main() {
  vec2 h = uTexel * 0.5;
  vec4 s = texture(uTex, vUV + vec2(-h.x * 2.0, 0.0));
  s += texture(uTex, vUV + vec2(-h.x, h.y)) * 2.0;
  s += texture(uTex, vUV + vec2(0.0, h.y * 2.0));
  s += texture(uTex, vUV + vec2(h.x, h.y)) * 2.0;
  s += texture(uTex, vUV + vec2(h.x * 2.0, 0.0));
  s += texture(uTex, vUV + vec2(h.x, -h.y)) * 2.0;
  s += texture(uTex, vUV + vec2(0.0, -h.y * 2.0));
  s += texture(uTex, vUV + vec2(-h.x, -h.y)) * 2.0;
  vec4 up = s / 12.0;
  vec4 base = texture(uBase, vUV);
  o = uAdd > 0.5 ? base * uBaseW + up : mix(base, up, uW);
}`;

export const COPY_FS = `${HEADER}
in vec2 vUV; uniform sampler2D uTex; uniform float uGain; out vec4 o;
void main() { o = texture(uTex, vUV) * uGain; }`;

export const COMPOSITE_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uBG, uMID, uFG;
out vec4 o;
void main() {
  vec4 bg = texture(uBG, vUV);
  vec4 mid = texture(uMID, vUV);
  vec4 fg = texture(uFG, vUV);
  vec3 c = bg.rgb;
  c = mid.rgb + c * (1.0 - mid.a);
  c = fg.rgb + c * (1.0 - fg.a);
  o = vec4(c, 1.0);
}`;

export const BRIGHT_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uTex; uniform float uThresh, uKnee;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThresh + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, l - uThresh) / max(l, 1e-4);
  o = vec4(c * w, 1.0);
}`;

export const RAYSRC_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uBG, uMID, uFG; uniform vec2 uSun; uniform float uR;
out vec4 o;
void main() {
  vec3 bg = texture(uBG, vUV).rgb;
  float occ = (1.0 - texture(uMID, vUV).a) * (1.0 - texture(uFG, vUV).a);
  float near = exp(-length((vUV - uSun) * vec2(1.7778, 1.0)) / uR);
  o = vec4(max(bg - 0.35, 0.0) * occ * near, 1.0);
}`;

export const GODRAYS_FS = `${HEADER}
in vec2 vUV;
uniform sampler2D uTex; uniform vec2 uSun; uniform float uDensity, uDecay, uWeight;
out vec4 o;
void main() {
  vec2 uv = vUV;
  vec2 delta = (uv - uSun) * uDensity / 72.0;
  float illum = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 72; i++) {
    uv -= delta;
    acc += texture(uTex, uv).rgb * illum * uWeight;
    illum *= uDecay;
  }
  o = vec4(acc, 1.0);
}`;

export const FINAL_FS = `${HEADER}${NOISE}
in vec2 vUV;
uniform sampler2D uScene, uBloom, uRays;
uniform vec2 uRes; uniform float uTime;
uniform float uExposure, uBloomAmt, uRaysAmt, uVignette, uGrain, uSat, uContrast, uFade, uFlash, uCA;
uniform vec3 uLift, uGain, uShadowTint, uHighTint;
uniform float uGamma, uDebug;
out vec4 o;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
  vec2 uv = vUV;
  vec2 dc = uv - 0.5;
  vec2 ca = dc * uCA / uRes;
  vec3 col;
  col.r = texture(uScene, uv - ca).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv + ca).b;
  if (uDebug > 0.5) { o = vec4(sqrt(texture(uBloom, uv).rgb * 8.0), 1.0); return; }
  col += texture(uBloom, uv).rgb * uBloomAmt;
  col += texture(uRays, uv).rgb * uRaysAmt;
  col *= uExposure;
  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col += uShadowTint * (1.0 - smoothstep(0.0, 0.5, l)) * 0.08 + uHighTint * smoothstep(0.5, 1.0, l) * 0.06;
  col = col * uGain + uLift * (1.0 - col);
  col = pow(max(col, 0.0), vec3(1.0 / uGamma));
  col = (col - 0.5) * uContrast + 0.5;
  float v = smoothstep(1.05, 0.2, length(dc * vec2(1.0, 0.85)));
  col *= mix(1.0 - uVignette, 1.0, v);
  float g = hash12(gl_FragCoord.xy * 1.37 + fract(uTime * 7.31) * 413.0) - 0.5;
  col += g * uGrain + (hash12(gl_FragCoord.yx + 3.7) - 0.5) / 255.0;
  col = mix(col, vec3(0.0), uFade);
  col = mix(col, vec3(1.0), uFlash);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
