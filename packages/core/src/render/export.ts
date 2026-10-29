/**
 * Exported pictures: an SVG that looks the same on any computer, and a PNG
 * drawn from it. Both are black on white, whatever the editor's theme.
 */
import type { Resvg } from '@resvg/resvg-wasm';
import type { Layout } from '../layout/layout';
import type { SizedDiagram } from '../layout/size';
import type { AttributeNode } from '../model/types';
import type { FontData } from '../text/measure';
import type { Subsetter } from '../text/subset';
import { STYLE } from './style';
import { LIGHT_THEME, renderSvg } from './svg';

/**
 * An SVG for export: light theme on a white background, with the fonts
 * embedded but cut down to the characters the diagram uses.
 */
export function exportSvg(
  sized: SizedDiagram,
  layout: Layout,
  fonts: FontData,
  subsetter: Subsetter,
): string {
  const text = diagramText(sized);
  const embedFont = {
    regular: subsetter.subset(fonts.regular, text),
    bold: subsetter.subset(fonts.bold, text),
  };
  return renderSvg(sized, layout, { theme: LIGHT_THEME, embedFont });
}

/** The parts of @resvg/resvg-wasm used; the caller loads it (`initWasm`) and passes it in. */
export interface ResvgModule {
  Resvg: typeof Resvg;
}

/**
 * Draws an exported SVG as a PNG, `scale` times its size in px, on white.
 *
 * resvg ignores the fonts embedded with @font-face, so they are passed to it
 * directly; without them it would leave every label out.
 */
export function renderPng(
  svg: string,
  resvg: ResvgModule,
  fonts: FontData,
  scale: number,
): Uint8Array {
  const image = new resvg.Resvg(svg, {
    font: {
      fontBuffers: [fonts.regular, fonts.bold],
      defaultFontFamily: STYLE.font.family,
      // Only the bundled font, so the picture is the same on every computer.
      loadSystemFonts: false,
    },
    fitTo: { mode: 'zoom', value: scale },
    background: '#ffffff',
  });
  const rendered = image.render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free();
    image.free();
  }
}

/** Every character drawn in the diagram: names, cardinalities and roles. */
export function diagramText(sized: SizedDiagram): string {
  const parts: string[] = [' '];
  const visit = (attributes: AttributeNode[]) => {
    for (const a of attributes) {
      parts.push(a.name);
      visit(a.children);
    }
  };
  for (const node of sized.diagram.nodes) {
    parts.push(node.name);
    visit(node.attributes);
  }
  for (const link of sized.diagram.links) parts.push(link.cardinality ?? '', link.role ?? '');
  return parts.join('');
}
