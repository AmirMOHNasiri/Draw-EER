/**
 * Public API of @draw-eer/core.
 *
 * The pipeline is: parse → buildDiagram → sizeDiagram → layoutDiagram → renderSvg.
 * `renderDiagram` runs all of it.
 */
import { buildDiagram } from './model/build';
import { layoutDiagram, type Layout } from './layout/layout';
import { sizeDiagram } from './layout/size';
import { renderSvg, type RenderOptions } from './render/svg';
import { parse } from './syntax/parser';
import type { ParseError } from './syntax/errors';
import type { TextMeasurer } from './text/measure';

export { parse } from './syntax/parser';
export type { ParseResult } from './syntax/parser';
export type { ParseError } from './syntax/errors';
export type * from './syntax/ast';

export { buildDiagram } from './model/build';
export type * from './model/types';

export { sizeDiagram, textBlock } from './layout/size';
export type { ElementGeometry, SizedDiagram, TextBlock } from './layout/size';
export { layoutDiagram } from './layout/layout';
export type { Layout } from './layout/layout';

export { renderSvg, LIGHT_THEME } from './render/svg';
export type { RenderOptions, Theme } from './render/svg';
export { STYLE } from './render/style';

export { createHarfBuzzMeasurer, createApproximateMeasurer } from './text/measure';
export type { FontData, HarfBuzzModule, TextMeasurer, TextStyle } from './text/measure';

export interface RenderResult {
  svg: string;
  errors: ParseError[];
  layout: Layout;
}

/** Parses, lays out and draws `.eer` source in one call. */
export function renderDiagram(
  source: string,
  measurer: TextMeasurer,
  options: RenderOptions = {},
): RenderResult {
  const { file, errors } = parse(source);
  const sized = sizeDiagram(buildDiagram(file), measurer);
  const layout = layoutDiagram(sized);
  return { svg: renderSvg(sized, layout, options), errors, layout };
}
