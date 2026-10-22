/**
 * A pressed-paper specimen for the first Form + Light chapter.
 *
 * Adapted from Estelle Kim's GlassineSurface material study:
 * softcopy-generative-materials/app/materials/GlassineSurface.tsx,
 * specifically sourceHigh, paperField, derivative normals and mipmapped scene
 * diffusion. The actual glassine2.webp scan supplies paper grain and the small
 * surface variations that catch light along the spherical grid's relief.
 * The grid is a fixed impression in one sheet; only its illumination moves.
 *
 * The owner controls readiness, animation, pointer smoothing and clipping.
 * This module never starts a render loop.
 */

export type GlassineLight = { x: number; y: number };

/** Normalized full-canvas bounds, with the DOM's top-left origin. */
export type GlassineBounds = { x: number; y: number; width: number; height: number };

export type GlassineRenderer = {
  resize: (cssWidth: number, cssHeight: number, dpr?: number) => void;
  draw: (light: GlassineLight, bounds?: GlassineBounds) => void;
  dispose: () => void;
};

type Options = {
  paperUrl: string;
  sceneUrl?: string;
  onReady: () => void;
  onError: (error: Error) => void;
};

type TextureResource = {
  unit: number;
  texture: WebGLTexture;
  image: HTMLImageElement;
};

const PIXEL_BUDGET = 1_000_000;
const MAX_DPR = 1.5;

export function createGlassineRenderer(canvas: HTMLCanvasElement, options: Options): GlassineRenderer {
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  const textures: TextureResource[] = [];
  let disposed = false;
  let failed = false;
  let ready = false;
  let loaded = 0;
  let sceneAspect = 1;
  let maxSize = 4096;
  let uniforms: Record<'resolution' | 'light' | 'paper' | 'scene' | 'sceneAspect' | 'specimen' | 'hasScene', WebGLUniformLocation> | null = null;

  const cleanup = () => {
    canvas.removeEventListener('webglcontextlost', onContextLost);
    for (const resource of textures) {
      resource.image.onload = null;
      resource.image.onerror = null;
      resource.image.removeAttribute('src');
      gl?.deleteTexture(resource.texture);
    }
    textures.length = 0;
    if (vao) gl?.deleteVertexArray(vao);
    if (program) gl?.deleteProgram(program);
    vao = null;
    program = null;
    uniforms = null;
  };

  const fail = (error: unknown) => {
    if (disposed || failed) return;
    failed = true;
    ready = false;
    cleanup();
    options.onError(error instanceof Error ? error : new Error(String(error)));
  };

  function onContextLost(event: Event) {
    event.preventDefault();
    fail(new Error('The glassine WebGL context was lost.'));
  }

  const renderer: GlassineRenderer = {
    resize(cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
      if (!gl || failed || disposed) return;
      const width = Number.isFinite(cssWidth) ? Math.max(1, cssWidth) : 1;
      const height = Number.isFinite(cssHeight) ? Math.max(1, cssHeight) : 1;
      const requested = Number.isFinite(dpr) ? Math.max(0.1, dpr) : 1;
      const scale = Math.min(requested, MAX_DPR, Math.sqrt(PIXEL_BUDGET / (width * height)), maxSize / Math.max(width, height));
      const pixelWidth = Math.max(1, Math.floor(width * scale));
      const pixelHeight = Math.max(1, Math.floor(height * scale));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    },
    draw(light, bounds) {
      if (!gl || !program || !vao || !uniforms || !ready || failed || disposed) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      for (const resource of textures) {
        gl.activeTexture(gl.TEXTURE0 + resource.unit);
        gl.bindTexture(gl.TEXTURE_2D, resource.texture);
      }
      gl.uniform1i(uniforms.paper, 0);
      // A complete sampler remains bound when the optional scene is absent.
      gl.uniform1i(uniforms.scene, options.sceneUrl ? 1 : 0);
      gl.uniform1f(uniforms.hasScene, options.sceneUrl ? 1 : 0);
      gl.uniform1f(uniforms.sceneAspect, sceneAspect);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      const x = Number.isFinite(bounds?.x) ? bounds!.x : 0;
      const y = Number.isFinite(bounds?.y) ? bounds!.y : 0;
      const width = Number.isFinite(bounds?.width) ? Math.max(0.001, bounds!.width) : 1;
      const height = Number.isFinite(bounds?.height) ? Math.max(0.001, bounds!.height) : 1;
      gl.uniform4f(uniforms.specimen, x, 1 - y - height, width, height);
      // The public coordinate convention is the DOM's top-left origin.
      gl.uniform2f(uniforms.light, finiteLight(light.x, 0.7), 1 - finiteLight(light.y, 0.3));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      cleanup();
    },
  };

  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('Glassine requires WebGL2.');
    canvas.addEventListener('webglcontextlost', onContextLost);
    maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
    program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not allocate the glassine vertex array.');
    uniforms = {
      resolution: getUniform(gl, program, 'uResolution'),
      light: getUniform(gl, program, 'uLight'),
      paper: getUniform(gl, program, 'uPaper'),
      scene: getUniform(gl, program, 'uScene'),
      sceneAspect: getUniform(gl, program, 'uSceneAspect'),
      specimen: getUniform(gl, program, 'uSpecimen'),
      hasScene: getUniform(gl, program, 'uHasScene'),
    };

    const loadTexture = (unit: number, url: string, repeats: boolean) => {
      const context = gl!;
      const texture = context.createTexture();
      if (!texture) throw new Error(`Could not allocate glassine texture ${unit}.`);
      const image = new Image();
      // Track the allocation before any upload or image setup can fail.
      textures.push({ unit, texture, image });
      context.activeTexture(context.TEXTURE0 + unit);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, repeats ? context.REPEAT : context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, repeats ? context.REPEAT : context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.generateMipmap(context.TEXTURE_2D);
      image.decoding = 'async';
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (disposed || failed) return;
        try {
          if (!image.naturalWidth || !image.naturalHeight || Math.max(image.naturalWidth, image.naturalHeight) > maxSize) {
            throw new Error(`Glassine texture ${unit} exceeds the device's texture limits.`);
          }
          context.activeTexture(context.TEXTURE0 + unit);
          context.bindTexture(context.TEXTURE_2D, texture);
          context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 1);
          context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
          context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image);
          context.generateMipmap(context.TEXTURE_2D);
          if (context.getError() !== context.NO_ERROR) throw new Error(`Could not upload glassine texture ${unit}.`);
          if (unit === 1) sceneAspect = image.naturalWidth / image.naturalHeight;
          image.onload = null;
          image.onerror = null;
          loaded += 1;
          if (loaded === (options.sceneUrl ? 2 : 1)) {
            ready = true;
            options.onReady();
          }
        } catch (error) {
          fail(error);
        }
      };
      image.onerror = () => fail(new Error(`Could not load the glassine ${unit === 0 ? 'scan' : 'scene'}.`));
      image.src = url;
    };

    loadTexture(0, options.paperUrl, true);
    if (options.sceneUrl) loadTexture(1, options.sceneUrl, false);
  } catch (error) {
    fail(error);
  }

  return renderer;
}

function finiteLight(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not allocate a glassine shader.');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Glassine shader compilation failed: ${gl.getShaderInfoLog(shader) || 'unknown error'}`);
      }
    }
    program = gl.createProgram();
    if (!program) throw new Error('Could not allocate the glassine program.');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Glassine shader linking failed: ${gl.getProgramInfoLog(program) || 'unknown error'}`);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function getUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  const uniform = gl.getUniformLocation(program, name);
  if (uniform === null) throw new Error(`Missing glassine uniform: ${name}`);
  return uniform;
}

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPaper;
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec2 uLight;
uniform float uSceneAspect;
uniform vec4 uSpecimen;
uniform float uHasScene;
out vec4 outColor;

float luma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

// Same scan high-pass as GlassineSurface: suppress uneven scan exposure,
// while preserving the paper's real fibers, creases and shallow scratches.
float sourceHigh(vec2 uv) {
  return luma(textureLod(uPaper, uv, 0.8).rgb) - luma(textureLod(uPaper, uv, 4.5).rgb);
}

float paperField(vec2 uv) {
  float broad = luma(textureLod(uPaper, uv, 6.0).rgb) - 0.13;
  return sourceHigh(uv) * 1.55 + broad * 0.18;
}

mat2 rotate2d(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

vec2 sceneUv(vec2 uv) {
  float aspect = (uResolution.x * uSpecimen.z) / (uResolution.y * uSpecimen.w);
  vec2 crop = uv - 0.5;
  if (aspect > uSceneAspect) crop.y *= uSceneAspect / aspect;
  else crop.x *= aspect / uSceneAspect;
  return crop + 0.5;
}

vec3 underlay(vec2 uv) {
  if (uHasScene < 0.5) return vec3(0.78, 0.79, 0.80);
  vec3 source = textureLod(uScene, sceneUv(uv), 4.2).rgb;
  return mix(vec3(luma(source)), source, 0.62);
}

// Project longitude and latitude from a sphere larger than the opening.
// Its tilted pole stays beyond the crop: we see curving quadrilateral cells,
// not a small globe sitting on the sheet or a second silhouette inside it.
vec2 sphericalGrid(vec2 p, float aspect) {
  float radius = max(0.96, aspect * 0.78);
  vec2 xy = (p - vec2(-aspect * 0.11, -0.20)) / radius;
  vec3 sphere = vec3(xy, sqrt(max(0.035, 1.0 - dot(xy, xy))));
  sphere = normalize(sphere);
  sphere.xz = rotate2d(-0.22) * sphere.xz;
  sphere.yz = rotate2d(0.48) * sphere.yz;
  sphere.xy = rotate2d(0.16) * sphere.xy;
  return vec2(atan(sphere.x, sphere.z), asin(clamp(sphere.y, -0.999, 0.999)))
    * vec2(8.0, 8.5) + vec2(0.18, 0.34);
}

// Convert angular distance into paper-space distance and its unit gradient.
// Both line families keep the same pressed width as cells compress. Carry the
// gradient forward so shading never differentiates a derivative expression.
vec3 gridProfile(vec2 grid, float pixelHeight) {
  vec2 cell = fract(grid + 0.5) - 0.5;
  vec2 dx = dFdx(grid) * pixelHeight;
  vec2 dy = dFdy(grid) * pixelHeight;
  vec2 gradient = max(sqrt(dx * dx + dy * dy), vec2(0.0001));
  vec2 distance = abs(cell) / gradient;
  if (distance.x < distance.y) {
    return vec3(distance.x, vec2(dx.x, dy.x) * sign(cell.x) / gradient.x);
  }
  return vec3(distance.y, vec2(dx.y, dy.y) * sign(cell.y) / gradient.y);
}

// The known relief width supplies a normal-footprint estimate. Narrow lobes
// lose energy before they become subpixel flicker at smaller buffer sizes.
float reflection(vec3 normal, vec3 halfVector, float exponent, float footprint) {
  float filtered = exponent / (1.0 + exponent * footprint * footprint);
  return pow(max(dot(normal, halfVector), 0.0), filtered) * filtered / exponent;
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution - uSpecimen.xy) / uSpecimen.zw;
  vec2 resolution = uResolution * uSpecimen.zw;
  float aspect = resolution.x / resolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float pixel = 1.0 / resolution.y;
  vec2 scanUv = (p + vec2(0.30, 0.12)) * 0.76 + 0.5;
  float grain = sourceHigh(scanUv);
  float field = paperField(scanUv);

  vec3 grid = gridProfile(sphericalGrid(p, aspect), resolution.y);
  float distance = grid.x;
  float width = max(0.0042, pixel * 0.85);
  float shoulderWidth = width * 0.68;
  float channel = exp(-pow(distance / width, 2.0));
  float shoulder = exp(-pow((distance - width * 1.65) / shoulderWidth, 2.0));
  // Derivative of a 0.0016-deep channel with 0.00048-high compressed shoulders.
  // The union has one depth at crossings, instead of stacking painted lines.
  float channelSlope = channel * (-2.0 * distance / (width * width));
  float shoulderSlope = shoulder * (-2.0 * (distance - width * 1.65) / (shoulderWidth * shoulderWidth));
  float pressedSlope = -0.0016 * channelSlope + 0.00048 * shoulderSlope;
  vec2 paperSlope = vec2(dFdx(field), dFdy(field)) * resolution.y * 0.00065;
  vec2 slope = grid.yz * pressedSlope + paperSlope;
  vec3 normal = normalize(vec3(-slope, 1.0));
  vec3 paperNormal = normalize(vec3(-paperSlope, 1.0));
  float normalFootprint = pixel / width * 0.15;

  vec2 lightXY = ((uLight - uSpecimen.xy) / uSpecimen.zw - uv) * vec2(aspect, 1.0);
  vec3 lightDirection = normalize(vec3(lightXY, 0.58));
  vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
  float diffuse = max(dot(normal, lightDirection), 0.0);
  float broad = reflection(normal, halfVector, 24.0, normalFootprint);
  float polished = reflection(normal, halfVector, 150.0, normalFootprint);

  // Leave the cells as quiet, fibrous paper. Reflective material is pressed
  // into the groove and its shoulders, with a small contact shadow below it.
  vec3 paper = mix(vec3(0.89, 0.88, 0.85), underlay(uv), 0.22);
  paper += vec3(grain * 0.32 + field * 0.045);
  vec3 color = paper * (0.89 + diffuse * 0.12);
  color -= vec3(0.045, 0.044, 0.041) * channel;
  float metal = max(channel * 0.74, shoulder);
  color += vec3(0.014) * reflection(paperNormal, halfVector, 14.0, pixel * 7.0);

  // A restrained pearl coating: changing normals shift the warm/cool balance
  // within the impression. There are no full-sheet rainbow bands.
  float facing = max(dot(normal, halfVector), 0.0);
  vec3 pearl = vec3(0.90, 0.94, 1.0) + vec3(0.10, 0.055, -0.045)
    * sin(facing * 12.0 + normal.x * 2.0 - normal.y * 1.5);
  color += pearl * metal * (broad * 0.070 + polished * 0.16);

  // Existing fibers are stationary microfacets. They glisten only where the
  // pressed coating, scan relief and light alignment all meet.
  float facet = smoothstep(0.012, 0.047, abs(grain));
  vec3 facetNormal = normalize(normal + vec3(-paperSlope * 2.4, 0.0));
  float glint = reflection(facetNormal, halfVector, 280.0, normalFootprint) * facet * metal;
  color += vec3(1.0, 0.98, 0.92) * glint * 0.23;

  // A single-pass scattering skirt around a lit ridge. It shares the same
  // light response and stays local to the press, without another framebuffer
  // or a screen-wide glow pass at the expense of the existing pixel budget.
  float skirt = exp(-pow(distance / (width * 3.8), 2.0));
  float softLight = reflection(paperNormal, halfVector, 38.0, pixel * 7.0);
  color += pearl * skirt * softLight * 0.025;
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
