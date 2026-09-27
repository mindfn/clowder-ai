// Thin WebGL2 layer: programs with typed uniform setters, HDR framebuffers,
// a fullscreen triangle, instanced quads and growable dynamic buffers.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('float render targets unavailable');
  gl.getExtension('OES_texture_float_linear');
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  return gl;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
      .join('\n');
    throw new Error(`shader compile failed:\n${log}\n${numbered}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vs, fs, name = 'program') {
    this.gl = gl;
    this.name = name;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`link failed (${name}): ${gl.getProgramInfoLog(p)}`);
    }
    this.p = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const base = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      const entry = { loc, type: info.type, size: info.size };
      if (info.type === gl.SAMPLER_2D) entry.unit = unit++;
      this.u[base] = entry;
    }
  }

  use(uniforms = {}) {
    const gl = this.gl;
    gl.useProgram(this.p);
    for (const k in uniforms) this.set(k, uniforms[k]);
    return this;
  }

  set(name, v) {
    const gl = this.gl;
    const e = this.u[name];
    if (!e) return;
    const l = e.loc;
    switch (e.type) {
      case gl.FLOAT:
        if (e.size > 1) gl.uniform1fv(l, v);
        else gl.uniform1f(l, v);
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(l, v);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(l, v);
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(l, v);
        break;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(l, v);
        break;
      case gl.FLOAT_MAT2:
        gl.uniformMatrix2fv(l, false, v);
        break;
      case gl.SAMPLER_2D:
        gl.activeTexture(gl.TEXTURE0 + e.unit);
        gl.bindTexture(gl.TEXTURE_2D, v && v.tex ? v.tex : v);
        gl.uniform1i(l, e.unit);
        break;
      default:
        throw new Error(`uniform type ${e.type} unsupported (${name})`);
    }
  }
}

export function texture(gl, w, h, { format = 'rgba16f', filter = 'linear', wrap = 'clamp', data = null } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const fmt = {
    rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
    rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT],
    rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
  }[format];
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt[0], w, h, 0, fmt[1], fmt[2], data);
  const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  const wr = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
  return { tex, w, h };
}

/** Upload an image/canvas as a premultiplied, mipmapped RGBA8 texture. */
export function imageTexture(gl, img, { mipmap = true, premultiply = true, wrap = 'clamp' } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const wr = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
  return { tex, w: img.width, h: img.height };
}

export class Target {
  constructor(gl, w, h, format = 'rgba16f') {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.t = texture(gl, w, h, { format });
    this.tex = this.t.tex;
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete ${st}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind(clear = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
    if (clear) {
      gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return this;
  }
}

/** Fullscreen triangle; vertex shader receives `aPos` in clip space. */
export function fullscreen(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return () => {
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };
}

/**
 * Instanced unit quad: attribute 0 = corner in [0,1]^2, attributes 1..k are
 * per-instance vec4s. `draw(data, count)` uploads `count * k` vec4s and draws.
 */
export class Instanced {
  constructor(gl, vec4PerInstance) {
    this.gl = gl;
    this.k = vec4PerInstance;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const q = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, q);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = 16 * vec4PerInstance;
    for (let i = 0; i < vec4PerInstance; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, stride, 16 * i);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    this.cap = 0;
  }
  draw(data, count) {
    if (!count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const n = count * this.k * 4;
    if (n > this.cap) {
      this.cap = Math.max(n, this.cap * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }
}

/** Plain triangle list with interleaved float attributes, sizes e.g. [2,4,4]. */
export class Mesh {
  constructor(gl, sizes) {
    this.gl = gl;
    this.sizes = sizes;
    this.stride = sizes.reduce((a, b) => a + b, 0);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    let off = 0;
    sizes.forEach((s, i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, s, gl.FLOAT, false, this.stride * 4, off * 4);
      off += s;
    });
    gl.bindVertexArray(null);
    this.cap = 0;
  }
  draw(data, floats, mode) {
    if (!floats) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (floats > this.cap) {
      this.cap = Math.max(floats, this.cap * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(mode ?? gl.TRIANGLES, 0, floats / this.stride);
    gl.bindVertexArray(null);
  }
}

/** Growable Float32Array writer. */
export class FloatWriter {
  constructor(n = 4096) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  reset() {
    this.n = 0;
    return this;
  }
  ensure(k) {
    if (this.n + k > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
      b.set(this.a);
      this.a = b;
    }
  }
  push(...v) {
    this.ensure(v.length);
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i];
  }
}

export const blend = {
  off(gl) {
    gl.disable(gl.BLEND);
  },
  premul(gl) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  },
  add(gl) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
  },
  max(gl) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
  },
};
