/**
 * A reduced glassine specimen renderer for the first Shape + Light chapter.
 *
 * Adapted from Estelle Kim's GlassineSurface material study:
 * softcopy-generative-materials/app/materials/GlassineSurface.tsx,
 * specifically sourceHigh, paperField, derivative normals, mipmapped scene
 * diffusion, Beer–Lambert transmission and the pearl-light response.
 * The actual glassine2.webp scan supplies both the relief and the density.
 * Botanical layers, procedural thickness noise and the controls UI are omitted.
 * Spectral hue accumulation, Gaussian swaths and the displaced RGB edge samples
 * are adapted from Estelle's softcopy.digital/studies/rainbow-canvas.html,
 * circleFragment. Here they respond to the sheet and light, not flight trails.
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

float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

vec2 sceneUv(vec2 uv) {
  float aspect = (uResolution.x * uSpecimen.z) / (uResolution.y * uSpecimen.w);
  vec2 crop = uv - 0.5;
  if (aspect > uSceneAspect) crop.y *= uSceneAspect / aspect;
  else crop.x *= aspect / uSceneAspect;
  return crop + 0.5;
}

vec3 underlay(vec2 uv, float lod) {
  if (uHasScene < 0.5) return vec3(0.78, 0.79, 0.80);
  vec3 source = textureLod(uScene, sceneUv(uv), lod).rgb;
  // A product still remains a product, softly diffused behind the sheet.
  // Its warmth supplies the contrast to the page's violet field.
  vec3 diffuse = mix(vec3(luma(source)), source, 0.72);
  return mix(diffuse, vec3(0.82, 0.79, 0.82), 0.12);
}

// The rainbow-canvas study's hue model stays saturated when fields overlap.
vec3 rainbow(float h) {
  vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), rgb, 0.92);
}

vec2 gaussianErf(vec2 x) {
  vec2 a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
  vec2 poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign(x) * (1.0 - poly * exp(-a * a));
}

float softRectangle(vec2 p, vec2 halfSize, float sigma) {
  vec2 coverage = 0.5 * (gaussianErf((p + halfSize) / (sigma * 1.41421356)) - gaussianErf((p - halfSize) / (sigma * 1.41421356)));
  return max(0.0, coverage.x * coverage.y);
}

float sheetEdgeLight(vec2 q, vec2 halfSize) {
  // Broad light scatters at the overlap. Its center remains transmissive.
  return softRectangle(q, halfSize, 0.045) * (1.0 - softRectangle(q, halfSize - vec2(0.035), 0.035));
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution - uSpecimen.xy) / uSpecimen.zw;
  vec2 resolution = uResolution * uSpecimen.zw;
  float aspect = resolution.x / resolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float aa = 1.5 / resolution.y;
  vec3 color = underlay(uv, 2.8);
  vec2 lightXY = ((uLight - uSpecimen.xy) / uSpecimen.zw - uv) * vec2(aspect, 1.0);
  vec3 lightDirection = normalize(vec3(lightXY, 0.28));
  vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
  vec3 spectralEmission = vec3(0.0);
  vec2 hueVector = vec2(0.0);
  float spectralDensity = 0.0;

  // Fixed overlapping sheets. Their edges cross the crop rather than form
  // another miniature interface inside the page's own moving aperture.
  for (int layer = 0; layer < 2; layer++) {
    float index = float(layer);
    vec2 center = layer == 0 ? vec2(-aspect * 0.14, 0.035) : vec2(aspect * 0.16, -0.16);
    float angle = layer == 0 ? -0.075 : 0.10;
    vec2 q = rotate2d(angle) * (p - center);
    vec2 halfSize = vec2(aspect * 0.48, layer == 0 ? 0.62 : 0.40);
    float distance = roundedBox(q, halfSize, 0.001);
    float mask = 1.0 - smoothstep(-aa, aa, distance);
    vec2 localUv = q / (halfSize * 2.0) + 0.5;
    // Separate fixed crops of the actual scan; no animated procedural grain.
    vec2 scanUv = localUv * vec2(0.82, 0.78) + vec2(0.08, 0.12) + index * vec2(0.21, 0.16);
    float field = paperField(scanUv);
    float height = field * 0.28;
    vec2 slope = vec2(dFdx(height), dFdy(height)) * resolution.y;
    vec3 normal = normalize(vec3(-slope * 0.045, 1.0));

    vec2 shadowOffset = rotate2d(angle) * vec2(-0.003, 0.004);
    float shadow = 1.0 - smoothstep(-aa, aa * 6.0, roundedBox(q + shadowOffset, halfSize, 0.001));
    color *= 1.0 - max(0.0, shadow - mask) * 0.055;

    vec3 blurredScene = underlay(uv + normal.xy * 0.0012, 4.2 + index * 0.45);
    vec3 under = mix(color, blurredScene, 0.16);
    float density = max(0.0, 0.48 + field * 0.30);
    float optical = exp(-density * mix(1.35, 0.18, 0.70));
    vec3 paperTint = vec3(0.91, 0.90, 0.87);
    vec3 sheet = mix(paperTint, under, optical);

    float diffuse = max(dot(normal, lightDirection), 0.0);
    float specular = pow(max(dot(normal, halfVector), 0.0), 42.0);
    float grazing = 1.0 - max(dot(lightDirection, vec3(0.0, 0.0, 1.0)), 0.0);
    sheet *= 0.90 + diffuse * 0.12;
    sheet += vec3(specular * 0.035);
    // A thin physical edge, not an added decorative outline.
    float edge = exp(-abs(distance) * resolution.y * 0.55) * mask;
    sheet += vec3(0.025) * edge * diffuse;
    color = mix(color, sheet, mask);

    // Exactly the warm/base/cool sample separation used by rainbow-canvas.
    // The fringes follow physical sheet boundaries, not the entire aperture.
    vec2 fringe = vec2(0.007, 0.0047);
    float base = sheetEdgeLight(q, halfSize);
    float warm = sheetEdgeLight(q + fringe, halfSize);
    float cool = sheetEdgeLight(q - fringe, halfSize);
    vec3 edgeChannels = mix(vec3(base), vec3(warm, base, cool), 0.50);
    // Low-frequency scan features, rather than noise, let a few real creases
    // catch color within the sheet. Most of its center remains quiet.
    float crease = smoothstep(0.018, 0.065, abs(luma(textureLod(uPaper, scanUv, 1.8).rgb) - luma(textureLod(uPaper, scanUv, 5.2).rgb)));
    float illumination = exp(-dot(lightXY, lightXY) * 1.5) * (0.55 + diffuse * 0.45);
    vec3 response = (edgeChannels * 2.4 + vec3(crease * 0.07 + specular * 0.045) * mask) * illumination;
    float hue = fract(0.68 + index * 0.28 + lightXY.x * 0.25 - lightXY.y * 0.16 + normal.x * 0.025 + grazing * 0.08);
    float weight = max(response.r, max(response.g, response.b));
    spectralEmission += pow(rainbow(hue), vec3(2.2)) * response;
    hueVector += vec2(cos(hue * 6.28318530718), sin(hue * 6.28318530718)) * weight;
    spectralDensity += weight;
  }
  float coherence = length(hueVector) / max(spectralDensity, 0.000001);
  float hue = atan(hueVector.y, hueVector.x) / 6.28318530718;
  vec3 hueColor = mix(vec3(1.0), rainbow(fract(hue + 1.0)), smoothstep(0.0, 0.30, coherence));
  vec3 separated = pow(spectralEmission / max(max(spectralEmission.r, max(spectralEmission.g, spectralEmission.b)), 0.000001), vec3(1.0 / 2.2));
  vec3 spectralTint = mix(hueColor, separated, 0.35);
  float spectralAmount = (1.0 - exp(-spectralDensity * 2.0)) * 0.82;
  color = mix(color, mix(color, spectralTint, 0.72), spectralAmount);
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
