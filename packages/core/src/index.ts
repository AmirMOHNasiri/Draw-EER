/**
 * Public API of @draw-eer/core.
 *
 * The pipeline is: parse → buildDiagram → sizeDiagram → layoutDiagram (or, with a
 * layout file, arrange) → renderSvg.
 * `renderDiagram` runs all of it.
 */
import { buildDiagram } from './model/build';
import type { Layout } from './layout/layout';
import { arrange } from './layout/incremental';
import { NO_POSITIONS, type Positions } from './layout/positions';
import { sizeDiagram } from './layout/size';
import { renderSvg, type RenderOptions } from './render/svg';
import { parse } from './syntax/parser';
import type { ParseError } from './syntax/errors';
import type { TextMeasurer } from './text/measure';

export { parse } from './syntax/parser';
export type { ParseResult } from './syntax/parser';
export type { Fix, ParseError, TextEdit } from './syntax/errors';
export type * from './syntax/ast';

export { buildDiagram } from './model/build';
export type * from './model/types';

export { sizeDiagram, textBlock } from './layout/size';
export type { ElementGeometry, SizedDiagram, TextBlock } from './layout/size';
export { layoutDiagram } from './layout/layout';
export type { Layout } from './layout/layout';
export { arrange, clearOfShapes, placeAround } from './layout/incremental';
export {
  isEmpty,
  moveTo,
  NO_POSITIONS,
  parseLayoutFile,
  pinAll,
  prunePositions,
  serializeLayoutFile,
  snap,
} from './layout/positions';
export type { Positions } from './layout/positions';

export { renderSvg, LIGHT_THEME } from './render/svg';
export type { RenderOptions, Theme } from './render/svg';
export { STYLE } from './render/style';
export { diagramText, exportSvg, renderPng } from './render/export';
export type { ResvgModule } from './render/export';

export { createHarfBuzzMeasurer, createApproximateMeasurer } from './text/measure';
export type { FontData, HarfBuzzModule, TextMeasurer, TextStyle } from './text/measure';
export { createSubsetter } from './text/subset';
export type { Subsetter } from './text/subset';

export interface RenderResult {
  svg: string;
  errors: ParseError[];
  layout: Layout;
}

/**
 * Parses, lays out and draws `.eer` source in one call. With `positions`
 * (from the layout file), pinned elements stay put and new ones are placed
 * around them (see `arrange`).
 */
export function renderDiagram(
  source: string,
  measurer: TextMeasurer,
  options: RenderOptions = {},
  positions: Positions = NO_POSITIONS,
): RenderResult {
  const { file, errors } = parse(source);
  const sized = sizeDiagram(buildDiagram(file), measurer);
  const { layout } = arrange(sized, positions);
  return { svg: renderSvg(sized, layout, options), errors, layout };
}
