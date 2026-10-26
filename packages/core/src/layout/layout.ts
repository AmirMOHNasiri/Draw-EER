import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { Point } from '../geometry/shapes';
import type { MainNode } from '../model/types';
import { STYLE } from '../render/style';
import { boxAround, boxesOverlap, segmentHitsBox } from '../geometry/collide';
import {
  candidateArrangements,
  layoutCluster,
  toUnits,
  type AttributeCluster,
  type Bounds,
  type Side,
} from './attributes';
import type { SizedDiagram } from './size';

/** ELK runs at most this many times per layout. */
const MAX_PASSES = 4;

/** Center of every node and attribute, by id. */
export type Layout = Map<string, Point>;

/**
 * Automatic layout.
 *
 * ELK's "layered" algorithm places entities and relationships in columns,
 * left to right, keeping lines short and avoiding crossings. Attributes are
 * not given to ELK; they are placed around their owner (see attributes.ts).
 *
 * It runs in passes:
 * 1. ELK places the bare shapes. From the result we learn which sides of
 *    each shape its relationship lines use.
 * 2. Attributes are arranged on the other sides, and ELK runs again with
 *    each shape enlarged to include its attributes, so nothing overlaps.
 * 3. Enlarged shapes can shift, changing which sides the lines use. If that
 *    changes any attribute sides, the attributes are rearranged and ELK runs
 *    once more.
 *
 * ELK only provides positions. Lines are drawn straight from border to
 * border, like in textbook figures, not along ELK's routes.
 */
export async function layoutDiagram(sized: SizedDiagram): Promise<Layout> {
  const { diagram, geometry } = sized;
  const elk = new ELK();
  const edges = elkEdges(sized);

  const bare = new Map<string, Bounds>();
  for (const node of diagram.nodes) {
    const { width, height } = geometry.get(node.id)!.shape;
    bare.set(node.id, { minX: -width / 2, maxX: width / 2, minY: -height / 2, maxY: height / 2 });
  }
  const firstPass = await runElk(elk, diagram.nodes, bare, edges);

  // Arrange attributes for the current positions, lay out again, and repeat
  // while the arrangement keeps changing (rarely more than once).
  let centers = firstPass;
  let placement = placeAttributes(sized, centers);
  for (let pass = 2; pass <= MAX_PASSES; pass++) {
    centers = await runElk(elk, diagram.nodes, placement.boxes, edges);
    if (pass === MAX_PASSES) break;
    const next = placeAttributes(sized, centers);
    if (next.signature === placement.signature) break;
    placement = next;
  }
  const clusters = placement.clusters;

  const layout: Layout = new Map();
  for (const node of diagram.nodes) {
    const center = centers.get(node.id)!;
    layout.set(node.id, center);
    for (const [id, offset] of clusters.get(node.id)!.positions) {
      layout.set(id, { x: center.x + offset.x, y: center.y + offset.y });
    }
  }
  return layout;
}

/** How many px of extra distance between attributes and their owner one crossing is worth. */
const CROSSING_COST = 400;
/** Cost of each side used beyond the first: a few attributes read best together. */
const EXTRA_SIDE_COST = 60;

/**
 * Arranges every node's attributes, given where the nodes currently are.
 * Each candidate arrangement gets a cost: lines and shapes running into its
 * attributes, plus how far the attributes are from their owner (so they stay
 * close). The cheapest wins; ties go to the earlier, more preferred one.
 */
function placeAttributes(sized: SizedDiagram, centers: Map<string, Point>) {
  const { diagram, geometry } = sized;
  const segments = diagram.links.map(
    (link) => [centers.get(link.entity)!, centers.get(link.relationship)!] as [Point, Point],
  );
  const clusters = new Map<string, AttributeCluster>();
  let signature = '';

  for (const node of diagram.nodes) {
    const shape = geometry.get(node.id)!.shape;
    const center = centers.get(node.id)!;
    const candidates = candidateArrangements(
      toUnits(node.attributes),
      blockedSides(sized, node, centers),
    );
    let best: { cluster: AttributeCluster; score: number; index: number } | null = null;
    candidates.forEach((arrangement, index) => {
      const cluster = layoutCluster(shape, arrangement, geometry);
      let distance = 0;
      for (const offset of cluster.positions.values()) distance += Math.hypot(offset.x, offset.y);
      const score =
        CROSSING_COST * crossings(sized, node.id, center, cluster, segments, centers) +
        EXTRA_SIDE_COST * Math.max(0, arrangement.sides.size - 1) +
        distance;
      if (best === null || score < best.score) best = { cluster, score, index };
    });
    const chosen = best!;
    clusters.set(node.id, chosen.cluster);
    signature += `${node.id}:${chosen.index};`;
  }
  const boxes = new Map([...clusters].map(([id, cluster]) => [id, cluster.bounds]));
  return { clusters, boxes, signature };
}

/** How many relationship lines and other shapes run into this node's attributes. */
function crossings(
  sized: SizedDiagram,
  ownerId: string,
  center: Point,
  cluster: AttributeCluster,
  segments: [Point, Point][],
  centers: Map<string, Point>,
): number {
  let score = 0;
  for (const [id, offset] of cluster.positions) {
    const { width, height } = sized.geometry.get(id)!.shape;
    const box = boxAround({ x: center.x + offset.x, y: center.y + offset.y }, width, height, 4);
    for (const [a, b] of segments) if (segmentHitsBox(a, b, box)) score++;
    for (const node of sized.diagram.nodes) {
      if (node.id === ownerId) continue;
      const shape = sized.geometry.get(node.id)!.shape;
      if (boxesOverlap(boxAround(centers.get(node.id)!, shape.width, shape.height, 8), box)) {
        score += 2;
      }
    }
  }
  return score;
}

/**
 * Edges for ELK, directed so that each relationship sits between its first
 * participant (on its left) and the others (on its right). In a unary
 * relationship both lines go to the first participant, so both stay on the left.
 */
function elkEdges(sized: SizedDiagram): ElkExtendedEdge[] {
  const firstParticipant = new Map<string, string>();
  return sized.diagram.links.map((link) => {
    const first = firstParticipant.get(link.relationship) ?? link.entity;
    firstParticipant.set(link.relationship, first);
    const [source, target] =
      link.entity === first ? [link.entity, link.relationship] : [link.relationship, link.entity];
    return { id: link.id, sources: [`${source}.out`], targets: [`${target}.in`] };
  });
}

/**
 * Runs ELK with each node given as `box` (relative to the node's center).
 * Returns the centers.
 *
 * Each node gets two ports at the height of its center, one on each side.
 * ELK straightens edges between ports, so shapes joined in a chain line up
 * on their centers even when their attributes make the boxes uneven.
 */
async function runElk(
  elk: InstanceType<typeof ELK>,
  nodes: MainNode[],
  boxes: Map<string, Bounds>,
  edges: ElkExtendedEdge[],
): Promise<Map<string, Point>> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(STYLE.layout.nodeSpacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(STYLE.layout.layerSpacing),
      'elk.spacing.componentComponent': String(STYLE.layout.componentSpacing),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.aspectRatio': '1.6',
    },
    children: nodes.map((node) => {
      const box = boxes.get(node.id)!;
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      const portY = -box.minY;
      return {
        id: node.id,
        width,
        height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          { id: `${node.id}.in`, x: 0, y: portY, width: 0, height: 0 },
          { id: `${node.id}.out`, x: width, y: portY, width: 0, height: 0 },
        ],
      };
    }),
    edges,
  };

  const result = await elk.layout(graph);
  const centers = new Map<string, Point>();
  for (const child of result.children ?? []) {
    const box = boxes.get(child.id)!;
    centers.set(child.id, { x: (child.x ?? 0) - box.minX, y: (child.y ?? 0) - box.minY });
  }
  return centers;
}

/**
 * Counts, for each side of a node, the relationship lines that leave toward
 * it: right is within 45° of horizontal to the right, and so on.
 */
function blockedSides(
  sized: SizedDiagram,
  node: MainNode,
  centers: Map<string, Point>,
): Record<Side, number> {
  const blocked: Record<Side, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  const here = centers.get(node.id)!;
  for (const link of sized.diagram.links) {
    const other =
      link.entity === node.id
        ? link.relationship
        : link.relationship === node.id
          ? link.entity
          : null;
    if (other === null) continue;
    const there = centers.get(other)!;
    const dx = there.x - here.x;
    const dy = there.y - here.y;
    const side: Side =
      Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
    blocked[side]++;
  }
  return blocked;
}
