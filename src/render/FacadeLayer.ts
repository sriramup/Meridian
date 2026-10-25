// Extruded building volumes with procedural facade articulation computed per
// fragment from real world-space coordinates: floor slabs at the building's
// floor height, mullions / punched windows / ribbon glazing by facade type,
// ground-contact occlusion, and (at night) lit windows.
//
// Facade type is carried in the fill colour's alpha byte (250 - type) so the
// layer needs no extra per-vertex attributes; 251 is a context building (roof
// only) and alpha 255 renders plain.

import { SolidPolygonLayer, type SolidPolygonLayerProps } from "@deck.gl/layers";
import type { ShaderModule } from "@luma.gl/shadertools";
import { daylight } from "./daylight";

export const FACADE = { glass: 0, masonry: 1, concrete: 2, metal: 3, timber: 4, stucco: 5, parking: 6, proposed: 7 } as const;
export const facadeAlpha = (t: number) => 250 - t;

const uniformBlock = /* glsl */ `
layout(std140) uniform facadeUniforms {
  float night;
  float detail;
  float dim;
  vec3 tone;
} facade;
`;

type FacadeProps = { night: number; detail: number; dim: number; tone: [number, number, number] };

const facadeModule = {
  name: "facade",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { night: "f32", detail: "f32", dim: "f32", tone: "vec3<f32>" },
} as const satisfies ShaderModule<FacadeProps>;

const fsCode = /* glsl */ `
float fac_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// d = screen-space footprint of one pixel in (metres along the facade, metres of height);
// patterns whose period falls below ~4 px fade to their area-average colour, so distant
// facades read as tone instead of aliasing into moiré / speckle.
float fac_fade(float dPerPeriod) { return smoothstep(0.12, 0.4, dPerPeriod); }

float fac_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fac_hash(i), fac_hash(i + vec2(1.0, 0.0)), f.x), mix(fac_hash(i + vec2(0.0, 1.0)), fac_hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// flat roofs: membrane, gravel or concrete, greyer and a little darker than the walls, one tone per
// roof (keyed on its height, so a podium and its tower differ), with weathering and, close up, grain
vec3 fac_roof(vec3 base, vec3 pos, float mpp) {
  float h = fac_hash(vec2(floor(pos.z * 2.0 + 0.5), 17.0));
  vec3 tone = base * mix(0.78, 0.94, h);
  tone = mix(tone, vec3(dot(tone, vec3(0.3333))), 0.4);
  float w = fac_noise(pos.xy / 11.0) * 0.6 + fac_noise(pos.xy / 3.3) * 0.4;
  tone *= mix(0.92, 1.03, w);
  float grain = fac_hash(floor(pos.xy / 0.5)) - 0.5;
  tone *= 1.0 + grain * 0.08 * (1.0 - smoothstep(0.12, 0.45, mpp));
  return tone;
}

vec3 fac_apply(vec3 base, vec3 pos, vec3 nrm, float type, vec2 d) {
  float z = pos.z;
  // ground-contact occlusion (and at podium joints)
  float ao = mix(0.78, 1.0, smoothstep(0.0, 7.0, z));
  vec2 n2 = normalize(nrm.xy + vec2(1e-5));
  if (abs(nrm.z) > 0.5) return fac_roof(base, pos, d.x);
  // type -1: surrounding context buildings, which get roofs and ground occlusion but no facade
  if (type < 0.0 || facade.detail < 0.5) return base * ao;
  float along = dot(pos.xy, vec2(-n2.y, n2.x));
  float fh = type == 0.0 ? 3.9 : type == 6.0 ? 3.1 : type == 5.0 ? 3.2 : 3.6;
  float fz = z / fh;
  float floorIdx = floor(fz);
  float fy = fract(fz);
  vec3 col = base;
  float lit = 0.0;
  float windowMask = 0.0;
  float fv = fac_fade(d.y / fh); // floor rhythm too fine to resolve
  float coverage = 0.0;
  if (type == 0.0 || type == 7.0) {
    // curtain wall: tinted glass, slab edges, mullions every 1.5 m
    float fu = max(fac_fade(d.x / 1.5), fv);
    float mull = (1.0 - smoothstep(0.0, 0.06, abs(fract(along / 1.5) - 0.5) - 0.44)) * (1.0 - fu);
    float slab = (1.0 - smoothstep(0.0, 0.03, abs(fy - 0.04) - 0.04)) * (1.0 - fv);
    vec3 glass = mix(base * vec3(0.62, 0.70, 0.78), vec3(0.80, 0.86, 0.92), 0.25 + 0.35 * smoothstep(0.0, 160.0, z));
    col = mix(glass, base * 0.98, max(mull * 0.6, slab * 0.85) + 0.1 * fu);
    windowMask = (1.0 - slab) * (1.0 - mull);
    coverage = 0.84;
  } else if (type == 1.0 || type == 4.0) {
    // punched windows 1.3 m wide on a 3.2 m bay
    float fu = max(fac_fade(d.x / 3.2), fv);
    float u = fract(along / 3.2);
    float wx = step(0.30, u) * step(u, 0.70);
    float wy = step(0.28, fy) * step(fy, 0.82);
    coverage = 0.216 * step(1.0, floorIdx + 0.5);
    windowMask = mix(wx * wy * step(1.0, floorIdx + 0.5), coverage, fu);
    col = mix(base, base * vec3(0.42, 0.46, 0.52), windowMask * 0.85);
  } else if (type == 2.0 || type == 3.0) {
    // ribbon windows with spandrel bands
    float fu = max(fac_fade(d.x / 2.0), fv);
    float wy = step(0.32, fy) * step(fy, 0.86);
    float mull = step(0.06, fract(along / 2.0));
    coverage = 0.51;
    windowMask = mix(wy * mull, coverage, fu);
    col = mix(base, base * vec3(0.48, 0.53, 0.60), windowMask * 0.8);
  } else if (type == 5.0) {
    float fu = max(fac_fade(d.x / 4.2), fv);
    float u = fract(along / 4.2);
    float wx = step(0.36, u) * step(u, 0.64);
    float wy = step(0.32, fy) * step(fy, 0.78);
    coverage = 0.13;
    windowMask = mix(wx * wy, coverage, fu);
    col = mix(base, base * vec3(0.5, 0.52, 0.56), windowMask * 0.7);
  } else if (type == 6.0) {
    // open parking deck
    float fu = max(fac_fade(d.x / 9.0), fv);
    float open = mix(step(0.38, fy) * step(fy, 0.9) * step(0.08, fract(along / 9.0)), 0.48, fu);
    col = mix(base, base * 0.35, open * 0.9);
  }
  if (facade.night > 0.01 && windowMask > 0.0) {
    // occupancy is coherent: units span several bays and whole floors tend to be on or off together
    float bay = type == 0.0 ? 1.5 : 3.2;
    float unitW = bay * (type == 0.0 ? 2.0 : 1.0);
    float h = fac_hash(vec2(floor(along / unitW), floorIdx));
    float floorBias = fac_hash(vec2(floorIdx, 3.7)) * 0.5 - 0.25;
    // distant facades: average occupancy glow instead of per-window flicker
    float far = max(fac_fade(d.x / unitW), fv);
    lit = mix(step(0.6 + floorBias, h) * windowMask, 0.38 * max(coverage, windowMask * 0.5), far);
    vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.95, 0.92, 0.85), fac_hash(vec2(floorIdx, 7.0)));
    col = mix(col * (1.0 - 0.75 * facade.night), warm * (0.55 + 0.3 * h), lit * facade.night);
    return col;
  }
  return col * ao * (1.0 - 0.72 * facade.night);
}
`;

/**
 * night: 0..1, or -1 (default) to follow the clock (daylight.night, read at draw time, so the hour
 * changing never changes props). nightTone: what the walls keep of their day colour at full night.
 */
type ExtraProps = { night?: number; detail?: number; nightTone?: [number, number, number] };
export type FacadeLayerProps<D> = SolidPolygonLayerProps<D> & ExtraProps;

export class FacadeLayer<D = unknown> extends SolidPolygonLayer<D, ExtraProps> {
  static layerName = "FacadeLayer";
  static defaultProps = { ...SolidPolygonLayer.defaultProps, night: -1, detail: 1, nightTone: [0.35, 0.37, 0.41] };

  getShaders(type: "top" | "side") {
    const shaders = super.getShaders(type);
    return {
      ...shaders,
      modules: [...shaders.modules, facadeModule],
      inject: {
        "vs:#decl": "out vec3 vFacPos;\nout vec3 vFacNormal;\nflat out float vFacType;\nout float vFacMpp;\n",
        "vs:#main-end": `
          vFacPos = vec3(props.positions.xy, props.positions.z + props.elevations);
          vFacNormal = props.normal;
          vFacType = floor(fillColors.a * 255.0 + 0.5);
          // metres per pixel at this vertex's depth (isotropic lower bound for the pattern fade)
          vFacMpp = (gl_Position.w / max(project.focalDistance, 1e-6)) / max(project.scale * project.commonUnitsPerMeter.z, 1e-9);
        `,
        "fs:#decl": "in vec3 vFacPos;\nin vec3 vFacNormal;\nflat in float vFacType;\nin float vFacMpp;\n" + fsCode,
        "fs:DECKGL_FILTER_COLOR": `
          // derivatives taken in uniform control flow, before the per-type branch
          vec2 facD = vec2(length(fwidth(vFacPos.xy)), fwidth(vFacPos.z));
          // some rasterisers return zero derivatives on parts of a quad; never let that disable the fade
          facD = max(facD, vec2(vFacMpp));
          // night grade: walls and roofs keep the layer's night tone of their day colour
          color.rgb *= mix(vec3(1.0), facade.tone, facade.dim);
          if (vFacType >= 242.5 && vFacType <= 251.5) {
            float ftype = floor(250.5 - vFacType); // integral type id; never compare a raw float with ==
            color.rgb = fac_apply(color.rgb, vFacPos, vFacNormal, ftype, facD);
            color.a = layer.opacity;
          }
        `,
      },
    };
  }

  draw(opts: Parameters<SolidPolygonLayer<D>["draw"]>[0]) {
    const p = this.props as unknown as FacadeLayerProps<D>;
    const follow = p.night === undefined || p.night < 0;
    const night = follow ? daylight.night : (p.night as number);
    const dim = follow ? daylight.dim : night;
    const tone = p.nightTone ?? [0.35, 0.37, 0.41];
    for (const model of this.getModels()) model.shaderInputs.setProps({ facade: { night, detail: p.detail ?? 1, dim, tone } });
    super.draw(opts);
  }
}
