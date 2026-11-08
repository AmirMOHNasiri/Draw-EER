import { it } from 'vitest';

/**
 * Fixtures that show a known layout problem, with the rule tests they break
 * (each fixture's opening comment describes the problem and the layout it
 * should get). Those tests run as expected failures: the suite passes while
 * the problem is there, and fails once a fix makes one pass, so that its
 * entry here is removed. These fixtures get no snapshot until they are fixed.
 */
const KNOWN_ISSUES: Record<string, ('symmetric tree' | 'slope' | 'clearance')[]> = {
  // A tree shared by two aggregates: their members leave it.
  'aggregate-shared-tree.eer': ['symmetric tree', 'slope', 'clearance'],
  // Two trees, one holding two of the aggregate's members: they leave it.
  'aggregate-two-members.eer': ['symmetric tree'],
};

export function hasKnownIssue(fixture: string): boolean {
  return fixture in KNOWN_ISSUES;
}

/** `it`, or `it.fails` where `fixture` is known to break `rule`. */
export function itUnlessKnown(
  fixture: string,
  rule: (typeof KNOWN_ISSUES)[string][number],
): typeof it | typeof it.fails {
  return KNOWN_ISSUES[fixture]?.includes(rule) ? it.fails : it;
}
