// The heat map as ONE layer that blends two modelled hours on the GPU.
//
// Each modelled hour is uploaded once as a single-channel texture of the model's own quantised
// values (sim/heat qT; 0 = no data), straight from the result's Uint8Array: no canvas, no
// ImageBitmap, no worker round trip, so an hour is never "not ready" and there is no frame in which
// a layer has no image. The fragment shader samples both hours of the bracket, interpolates the
// VALUE (temperature) by t, and only then colours it through the palette lookup table, so a pixel
// moves monotonically along the legend between the hours (never through an unrelated mixed colour,
// never through transparent/white). Crossing the hour mark only changes which two textures are bound
// and t, and both sides of the mark draw the same picture (t = 1 of one bracket = t = 0 of the next).

import { Layer, project32, type DefaultProps, type LayerProps, type UpdateParameters } from "@deck.gl/core";
import { Model, Geometry } from "@luma.gl/engine";
import type { Device, Texture } from "@luma.gl/core";

export interface HeatBlendProps extends LayerProps {
  /** grid of the values (local metres) */
  grid: { x0: number; y0: number; cell: number; nx: number; ny: number };
  /** quantised values of the earlier hour of the bracket (row-major, j = 0 at the south edge) */
  valuesA: Uint8Array | null;
  /** quantised values of the later hour */
  valuesB: Uint8Array | null;
  /** 0..1: how far between A and B */
  mix: number;
  /** per-cell 0..255 fade (the city edge), same layout as the values */
  fade: Uint8Array;
  /** 256 × RGBA colours for the quantised values (entry 0 unused) */
  lut: Uint8Array;
}

// ---- textures: one per values array, kept while the array is in use --------------------------

interface Entry {
  tex: Texture;
  used: number;
}
const MAX_TEXTURES = 72;
let frame = 0;
const textures = new Map<object, Entry>();
const device0: { d: Device | null } = { d: null };

/** the texture holding `data` (created and uploaded on first use, synchronously) */
function textureFor(device: Device, data: Uint8Array, w: number, h: number, format: "r8unorm" | "rgba8unorm"): Texture {
  if (device0.d !== device) {
    for (const e of textures.values()) e.tex.destroy();
    textures.clear();
    device0.d = device;
  }
  let e = textures.get(data);
  if (!e) {
    const tex = device.createTexture({
      format,
      width: w,
      height: h,
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
    });
    tex.writeData(data);
    e = { tex, used: frame };
    textures.set(data, e);
    evict();
  }
  e.used = frame;
  return e.tex;
}

/** drop the least recently used textures over the cap (never one drawn in the last two frames) */
function evict() {
  if (textures.size <= MAX_TEXTURES) return;
  const old = [...textures].filter(([, e]) => e.used < frame - 2).sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of old) {
    if (textures.size <= MAX_TEXTURES) break;
    e.tex.destroy();
    textures.delete(k);
  }
}

/** for tests / diagnostics */
export const heatTextureStats = () => ({ textures: textures.size, frame });

// ---- the blend: pure function mirrored by the shader (tested in tests/heat-blend.test.ts) -----

/**
 * The value drawn between two hours: interpolated where both have data, the one that has data where
 * only one does (so a cell never blinks out mid-blend), null where neither does.
 */
export function blendValue(qa: number, qb: number, t: number): number | null {
  if (!qa && !qb) return null;
  if (!qa) return qb;
  if (!qb) return qa;
  return qa + (qb - qa) * t;
}

// ---- shaders ----------------------------------------------------------------------------------

const uniformBlock = /* glsl */ `\
layout(std140) uniform heatBlendUniforms {
  vec4 bounds;
  float mixT;
  float opacity;
} heatBlend;
`;

const heatBlendModule = {
  name: "heatBlend",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { bounds: "vec4<f32>", mixT: "f32", opacity: "f32" },
} as const;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME heat-blend-vertex
in vec3 positions;
out vec2 vUV;
void main(void) {
  vec4 b = heatBlend.bounds;
  // grid UV: u east, v north (row 0 of the values is the south edge)
  vUV = (positions.xy - b.xy) / (b.zw - b.xy);
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0));
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME heat-blend-fragment
precision highp float;
uniform sampler2D valuesA;
uniform sampler2D valuesB;
uniform sampler2D fadeTexture;
uniform sampler2D lutTexture;
in vec2 vUV;
out vec4 fragColor;
void main(void) {
  float qa = floor(texture(valuesA, vUV).r * 255.0 + 0.5);
  float qb = floor(texture(valuesB, vUV).r * 255.0 + 0.5);
  float f = texture(fadeTexture, vUV).r;
  if ((qa < 0.5 && qb < 0.5) || f <= 0.0) discard;
  float q = qa < 0.5 ? qb : qb < 0.5 ? qa : mix(qa, qb, heatBlend.mixT);
  // palette entry of the blended value (entries are 1..255)
  vec4 c = texture(lutTexture, vec2((clamp(floor(q + 0.5), 1.0, 255.0) + 0.5) / 256.0, 0.5));
  fragColor = vec4(c.rgb, c.a * f * heatBlend.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// the arrays are cached by their producers and textures are keyed by array identity, so they
// compare by reference: a deep compare walks every cell (up to ~10⁶) on each step of the clock
const defaultProps: DefaultProps<HeatBlendProps> = {
  grid: { type: "object", value: { x0: 0, y0: 0, cell: 1, nx: 1, ny: 1 }, compare: true },
  valuesA: { type: "object", value: null, compare: false },
  valuesB: { type: "object", value: null, compare: false },
  mix: { type: "number", value: 0 },
  fade: { type: "object", value: new Uint8Array(1), compare: false },
  lut: { type: "object", value: new Uint8Array(1024), compare: false },
};

export class HeatBlendLayer extends Layer<HeatBlendProps> {
  static layerName = "HeatBlendLayer";
  static defaultProps = defaultProps;
  declare state: { model?: Model };

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, heatBlendModule] });
  }

  initializeState() {
    this.setState({ model: this._model() });
  }

  updateState(p: UpdateParameters<this>) {
    super.updateState(p);
    if (p.props.grid !== p.oldProps.grid) {
      this.state.model?.destroy();
      this.setState({ model: this._model() });
    }
  }

  finalizeState(ctx: Parameters<Layer["finalizeState"]>[0]) {
    super.finalizeState(ctx);
    this.state.model?.destroy();
  }

  _model(): Model {
    const g = this.props.grid;
    const x1 = g.x0 + g.nx * g.cell,
      y1 = g.y0 + g.ny * g.cell;
    // two triangles over the grid
    const positions = new Float32Array([g.x0, g.y0, 0, x1, g.y0, 0, x1, y1, 0, g.x0, g.y0, 0, x1, y1, 0, g.x0, y1, 0]);
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: new Geometry({ topology: "triangle-list", attributes: { positions: { size: 3, value: positions } } }),
      isInstanced: false,
    });
  }

  draw() {
    const { model } = this.state;
    const { grid: g, valuesA, valuesB, fade, lut, mix, opacity } = this.props;
    if (!model || (!valuesA && !valuesB)) return;
    frame++;
    const device = this.context.device;
    const a = valuesA ?? valuesB!,
      b = valuesB ?? valuesA!;
    model.setBindings({
      valuesA: textureFor(device, a, g.nx, g.ny, "r8unorm"),
      valuesB: textureFor(device, b, g.nx, g.ny, "r8unorm"),
      fadeTexture: textureFor(device, fade, g.nx, g.ny, "r8unorm"),
      lutTexture: textureFor(device, lut, 256, 1, "rgba8unorm"),
    });
    model.shaderInputs.setProps({ heatBlend: { bounds: [g.x0, g.y0, g.x0 + g.nx * g.cell, g.y0 + g.ny * g.cell], mixT: Math.max(0, Math.min(1, mix)), opacity } });
    model.draw(this.context.renderPass);
  }
}

if (typeof window !== "undefined") (window as unknown as { __meridianRaster: unknown }).__meridianRaster = { heat: heatTextureStats };
