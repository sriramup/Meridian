// Night grading on the GPU: a layer extension that darkens a layer's day colours towards its night
// tone by the current `daylight.night`, read at draw time. The hour changing is a uniform update
// and a redraw; no layer props change and no attribute is rebuilt or re-uploaded.

import { LayerExtension, type Layer } from "@deck.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { daylight } from "./daylight";
import type { RGB } from "./theme";

type DuskProps = { night: number; tone: [number, number, number] };

const uniformBlock = /* glsl */ `
layout(std140) uniform duskUniforms {
  float night;
  vec3 tone;
} dusk;
`;

const duskModule = {
  name: "dusk",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { night: "f32", tone: "vec3<f32>" },
  inject: {
    // runs before picking's own colour filter, so picking colours are untouched
    "fs:DECKGL_FILTER_COLOR": `color.rgb *= mix(vec3(1.0), dusk.tone, dusk.night);`,
  },
} as const satisfies ShaderModule<DuskProps>;

export type DuskExtensionProps = { duskTone?: RGB };

export class DuskExtension extends LayerExtension {
  static extensionName = "DuskExtension";
  static defaultProps = { duskTone: [0.2, 0.22, 0.26] };

  getShaders() {
    return { modules: [duskModule] };
  }

  draw(this: Layer<DuskExtensionProps>) {
    const tone = (this.props.duskTone ?? [0.2, 0.22, 0.26]) as [number, number, number];
    this.setShaderModuleProps({ dusk: { night: daylight.dim, tone } });
  }
}

/** one shared instance: deck.gl compares extensions by reference */
export const dusk = new DuskExtension();

const ONLY = [dusk];
const WITH = new Map<LayerExtension, LayerExtension[]>();
/** props that grade a layer towards `tone` at night (spread into the layer's props) */
export function duskProps(tone: RGB, other?: LayerExtension): { extensions: LayerExtension[] } {
  let extensions = ONLY as LayerExtension[];
  if (other) {
    extensions = WITH.get(other) ?? [other, dusk];
    WITH.set(other, extensions);
  }
  return { extensions, duskTone: tone } as { extensions: LayerExtension[] };
}
