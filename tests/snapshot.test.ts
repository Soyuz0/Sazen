import { describe, expect, it } from "vitest";
import { createAgentPageDescription, diffSnapshots, tokenOptimizedSnapshot } from "../src/snapshot.js";
import type { AgentNode, DomSnapshot } from "../src/types.js";

function makeNode(partial: Partial<AgentNode> & Pick<AgentNode, "id">): AgentNode {
  return {
    id: partial.id,
    stableRef: partial.stableRef ?? `id:${partial.id}`,
    tag: partial.tag ?? "button",
    role: partial.role ?? "button",
    name: partial.name ?? "Button",
    text: partial.text ?? "Button",
    value: partial.value ?? "",
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    editable: partial.editable ?? false,
    interactive: partial.interactive ?? true,
    boundingBox: partial.boundingBox ?? { x: 0, y: 0, width: 100, height: 32 },
    path: partial.path ?? `body > button[data-id="${partial.id}"]`,
    attributes: partial.attributes ?? {}
  };
}

function makeSnapshot(id: string, nodes: AgentNode[]): DomSnapshot {
  return {
    snapshotId: id,
    timestamp: Date.now(),
    url: "http://example.test",
    title: "Example",
    domHash: `${id}-hash`,
    viewport: {
      width: 1280,
      height: 720
    },
    nodeCount: nodes.length,
    interactiveCount: nodes.filter((node) => node.interactive).length,
    nodes
  };
}

describe("snapshot diff", () => {
  it("detects added removed and changed nodes", () => {
    const before = makeSnapshot("before", [
      makeNode({ id: "node_1", text: "Submit" }),
      makeNode({ id: "node_2", text: "Cancel" })
    ]);

    const after = makeSnapshot("after", [
      makeNode({ id: "node_1", text: "Submit now" }),
      makeNode({ id: "node_3", text: "Retry" })
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.changed).toBe(1);
    expect(diff.added[0].id).toBe("node_3");
    expect(diff.removed[0].id).toBe("node_2");
    expect(diff.changed[0].id).toBe("node_1");
    expect(diff.changed[0].changes[0].field).toBe("text");
  });

  it("produces token optimized snapshot with relevant nodes", () => {
    const snapshot = makeSnapshot("snap", [
      makeNode({ id: "node_1", interactive: true, role: "button", name: "Submit", text: "Submit" }),
      makeNode({
        id: "node_2",
        interactive: false,
        visible: true,
        role: "generic",
        name: "",
        text: "Helpful status text"
      }),
      makeNode({
        id: "node_3",
        interactive: false,
        visible: false,
        role: "generic",
        name: "",
        text: "Hidden"
      })
    ]);

    const optimized = tokenOptimizedSnapshot(snapshot);
    const nodes = optimized.nodes as Array<{ id: string }>;

    expect(nodes.map((node) => node.id)).toEqual(["node_1", "node_2"]);
  });

  it("builds agent-oriented page description with issue hints", () => {
    const snapshot = makeSnapshot("agent", [
      makeNode({ id: "node_1", role: "button", name: "Submit", text: "Submit", interactive: true }),
      makeNode({
        id: "node_2",
        role: "button",
        name: "Submit",
        text: "Submit",
        interactive: true,
        boundingBox: { x: 10, y: 10, width: 12, height: 12 }
      }),
      makeNode({
        id: "node_3",
        role: "button",
        name: "Disabled",
        text: "Disabled",
        interactive: true,
        enabled: false
      })
    ]);

    const description = createAgentPageDescription(snapshot, { maxElements: 10 });
    expect(description.interactiveElements).toHaveLength(3);
    expect(description.interactiveElements[0].suggestedActions).toContain("click");
    expect(description.potentialIssues.join(" ")).toMatch(/disabled|duplicate|small hit areas/i);
  });
});
