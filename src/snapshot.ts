import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type {
  AgentElementDescription,
  AgentNode,
  AgentPageDescription,
  ChangedNode,
  DomDiff,
  DomSnapshot,
  SuggestedAction
} from "./types.js";

interface RawNode {
  id: string;
  stableRef: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  value: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  interactive: boolean;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  path: string;
  attributes: Record<string, string>;
}

interface RawSnapshot {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  nodes: RawNode[];
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  visibleOnly?: boolean;
  maxNodes?: number;
}

const DEFAULT_OPTIONS: Required<SnapshotOptions> = {
  interactiveOnly: false,
  visibleOnly: false,
  maxNodes: 10_000
};

export async function takeDomSnapshot(
  page: Page,
  options: SnapshotOptions = {}
): Promise<DomSnapshot> {
  const effective = { ...DEFAULT_OPTIONS, ...options };

  const raw = await page.evaluate<RawSnapshot, Required<SnapshotOptions>>((snapshotOptions) => {
    const globalState = window as unknown as {
      __agentNodeRuntime?: {
        nextId: number;
        nodeIds: WeakMap<Element, string>;
      };
    };

    if (!globalState.__agentNodeRuntime) {
      globalState.__agentNodeRuntime = {
        nextId: 1,
        nodeIds: new WeakMap<Element, string>()
      };
    }

    const runtime = globalState.__agentNodeRuntime;

    const interactiveTags = new Set([
      "A",
      "BUTTON",
      "INPUT",
      "SELECT",
      "TEXTAREA",
      "SUMMARY",
      "OPTION",
      "LABEL"
    ]);

    const interactiveRoles = new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "switch",
      "combobox",
      "listbox",
      "menuitem",
      "option",
      "tab"
    ]);

    const sanitize = (input: string | null | undefined): string =>
      (input ?? "").replace(/\s+/g, " ").trim();

    const resolveRole = (el: Element): string => {
      const explicit = sanitize(el.getAttribute("role"));
      if (explicit) {
        return explicit;
      }

      const tag = el.tagName.toLowerCase();
      if (tag === "a" && (el as HTMLAnchorElement).href) {
        return "link";
      }
      if (tag === "button") {
        return "button";
      }
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (type === "checkbox") {
          return "checkbox";
        }
        if (type === "radio") {
          return "radio";
        }
        if (type === "submit" || type === "button") {
          return "button";
        }
        return "textbox";
      }
      if (tag === "select") {
        return "combobox";
      }
      if (tag === "textarea") {
        return "textbox";
      }
      return "generic";
    };

    const resolveName = (el: Element): string => {
      const ariaLabel = sanitize(el.getAttribute("aria-label"));
      if (ariaLabel) {
        return ariaLabel;
      }

      const labelledBy = sanitize(el.getAttribute("aria-labelledby"));
      if (labelledBy) {
        const label = document.getElementById(labelledBy);
        if (label) {
          const text = sanitize(label.textContent);
          if (text) {
            return text;
          }
        }
      }

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el.labels && el.labels.length > 0) {
          const firstLabel = sanitize(el.labels[0]?.textContent);
          if (firstLabel) {
            return firstLabel;
          }
        }
        const placeholder = sanitize((el as HTMLInputElement).placeholder);
        if (placeholder) {
          return placeholder;
        }
      }

      const title = sanitize(el.getAttribute("title"));
      if (title) {
        return title;
      }

      const text = sanitize(el.textContent);
      if (text) {
        return text.slice(0, 120);
      }

      return "";
    };

    const elementText = (el: Element): string => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return sanitize(el.value).slice(0, 120);
      }
      return sanitize(el.textContent).slice(0, 120);
    };

    const valueForElement = (el: Element): string => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return sanitize(el.value).slice(0, 120);
      }
      return "";
    };

    const cssPath = (el: Element): string => {
      const build = (node: Element): string => {
        const tag = node.tagName.toLowerCase();
        const id = sanitize(node.getAttribute("id"));
        if (id) {
          return `${tag}#${CSS.escape(id)}`;
        }

        const parent = node.parentElement;
        if (!parent) {
          return tag;
        }

        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName
        );
        if (sameTagSiblings.length === 1) {
          return tag;
        }

        const index = sameTagSiblings.indexOf(node) + 1;
        return `${tag}:nth-of-type(${index})`;
      };

      const parts: string[] = [];
      let current: Element | null = el;

      while (current && current !== document.body) {
        parts.unshift(build(current));
        const currentId = sanitize(current.getAttribute("id"));
        if (currentId) {
          break;
        }
        current = current.parentElement;
      }

      if (parts.length === 0) {
        return "body";
      }

      return `body > ${parts.join(" > ")}`;
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }

      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const isEnabled = (el: Element): boolean => {
      if (
        el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return !el.disabled;
      }

      if (el.hasAttribute("aria-disabled")) {
        return sanitize(el.getAttribute("aria-disabled")) !== "true";
      }

      return true;
    };

    const resolveStableRef = (el: Element, role: string, name: string, path: string): string => {
      const testId = sanitize(el.getAttribute("data-testid"));
      if (testId) {
        return `testid:${testId}`;
      }

      const id = sanitize(el.getAttribute("id"));
      if (id) {
        return `id:${id}`;
      }

      const ariaLabel = sanitize(el.getAttribute("aria-label"));
      if (ariaLabel) {
        return `aria:${ariaLabel}`;
      }

      const nameAttr = sanitize(el.getAttribute("name"));
      if (nameAttr) {
        return `name:${nameAttr}`;
      }

      const link = el instanceof HTMLAnchorElement ? sanitize(el.href) : "";
      if (link) {
        return `href:${link}`;
      }

      const text = elementText(el);
      if (role !== "generic" || name || text) {
        const textPart = text ? text.slice(0, 40) : "";
        return `semantic:${role}|${name.slice(0, 40)}|${textPart}`;
      }

      return `path:${path}`;
    };

    const attributesForElement = (el: Element): Record<string, string> => {
      const names = [
        "id",
        "name",
        "type",
        "placeholder",
        "href",
        "aria-label",
        "data-testid"
      ];

      const attrs: Record<string, string> = {};
      for (const name of names) {
        const value = sanitize(el.getAttribute(name));
        if (value) {
          attrs[name] = value;
        }
      }

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const value = sanitize(el.value);
        if (value) {
          attrs.value = value.slice(0, 120);
        }
      }

      return attrs;
    };

    const allElements = Array.from(document.querySelectorAll("*"));
    const nodes: RawNode[] = [];

    for (const el of allElements) {
      if (el.closest("[data-agent-browser-overlay='root']")) {
        continue;
      }

      const role = resolveRole(el);
      const name = resolveName(el);
      const path = cssPath(el);

      let nodeId = runtime.nodeIds.get(el);
      if (!nodeId) {
        nodeId = `node_${runtime.nextId++}`;
        runtime.nodeIds.set(el, nodeId);
      }

      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      const enabled = isEnabled(el);
      const editable =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

      const interactive =
        interactiveTags.has(el.tagName) ||
        interactiveRoles.has(role) ||
        (el instanceof HTMLElement && el.tabIndex >= 0) ||
        el.hasAttribute("onclick");

      if (snapshotOptions.visibleOnly && !visible) {
        continue;
      }

      if (snapshotOptions.interactiveOnly && !interactive) {
        continue;
      }

      nodes.push({
        id: nodeId,
        stableRef: resolveStableRef(el, role, name, path),
        tag: el.tagName.toLowerCase(),
        role,
        name,
        text: elementText(el),
        value: valueForElement(el),
        visible,
        enabled,
        editable,
        interactive,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        path,
        attributes: attributesForElement(el)
      });

      if (nodes.length >= snapshotOptions.maxNodes) {
        break;
      }
    }

    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      nodes
    };
  }, effective);

  const hashInput = raw.nodes
    .map((node) => `${node.id}|${node.stableRef}|${node.visible}|${node.enabled}|${node.text}|${node.value}`)
    .join("\n");
  const domHash = createHash("sha1").update(hashInput).digest("hex").slice(0, 16);

  const snapshot: DomSnapshot = {
    snapshotId: randomUUID(),
    timestamp: Date.now(),
    url: raw.url,
    title: raw.title,
    domHash,
    viewport: raw.viewport,
    nodeCount: raw.nodes.length,
    interactiveCount: raw.nodes.filter((node) => node.interactive).length,
    nodes: raw.nodes as AgentNode[]
  };

  return snapshot;
}

export function diffSnapshots(before: DomSnapshot, after: DomSnapshot): DomDiff {
  const beforeMap = new Map(before.nodes.map((node) => [node.id, node]));
  const afterMap = new Map(after.nodes.map((node) => [node.id, node]));

  const added: AgentNode[] = [];
  const removed: AgentNode[] = [];
  const changed: ChangedNode[] = [];

  for (const [id, node] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push(node);
    }
  }

  for (const [id, node] of beforeMap) {
    const next = afterMap.get(id);
    if (!next) {
      removed.push(node);
      continue;
    }

    const changes = [];
    if (node.text !== next.text) {
      changes.push({ field: "text", before: node.text, after: next.text } as const);
    }
    if (node.value !== next.value) {
      changes.push({ field: "value", before: node.value, after: next.value } as const);
    }
    if (node.visible !== next.visible) {
      changes.push({ field: "visible", before: node.visible, after: next.visible } as const);
    }
    if (node.enabled !== next.enabled) {
      changes.push({ field: "enabled", before: node.enabled, after: next.enabled } as const);
    }
    if (node.name !== next.name) {
      changes.push({ field: "name", before: node.name, after: next.name } as const);
    }

    if (changes.length > 0) {
      changed.push({
        id,
        stableRef: next.stableRef,
        changes
      });
    }
  }

  return {
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length
    }
  };
}

export function tokenOptimizedSnapshot(snapshot: DomSnapshot): Record<string, unknown> {
  const nodes = snapshot.nodes
    .filter((node) => node.interactive || (node.visible && node.text.length > 0))
    .map((node) => ({
      id: node.id,
      ref: node.stableRef,
      role: node.role,
      name: node.name,
      text: node.text.slice(0, 80),
      visible: node.visible,
      enabled: node.enabled,
      interactive: node.interactive
    }));

  return {
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    title: snapshot.title,
    domHash: snapshot.domHash,
    viewport: snapshot.viewport,
    nodeCount: snapshot.nodeCount,
    interactiveCount: snapshot.interactiveCount,
    nodes
  };
}

export function createAgentPageDescription(
  snapshot: DomSnapshot,
  options: {
    maxElements?: number;
  } = {}
): AgentPageDescription {
  const maxElements = options.maxElements ?? 80;

  const interactiveElements = snapshot.nodes
    .filter((node) => node.interactive)
    .sort((left, right) => {
      const leftConfidence = scoreInteractionConfidence(
        left,
        snapshot.viewport.width,
        snapshot.viewport.height
      ).score;
      const rightConfidence = scoreInteractionConfidence(
        right,
        snapshot.viewport.width,
        snapshot.viewport.height
      ).score;
      return rightConfidence - leftConfidence || left.id.localeCompare(right.id);
    })
    .slice(0, maxElements)
    .map((node): AgentElementDescription => {
      const confidence = scoreInteractionConfidence(
        node,
        snapshot.viewport.width,
        snapshot.viewport.height
      );
      return {
        inViewport: isBoxInViewport(node.boundingBox, snapshot.viewport.width, snapshot.viewport.height),
        id: node.id,
        stableRef: node.stableRef,
        role: node.role,
        name: node.name,
        text: node.text,
        bbox: node.boundingBox,
        visible: node.visible,
        enabled: node.enabled,
        interactive: node.interactive,
        location: describeLocation(node.boundingBox, snapshot.viewport.width, snapshot.viewport.height),
        suggestedActions: suggestedActionsForNode(node),
        confidenceScore: confidence.score,
        confidenceReasons: confidence.reasons
      };
    });

  const potentialIssues = detectPotentialIssues(snapshot);

  return {
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    title: snapshot.title,
    domHash: snapshot.domHash,
    viewport: snapshot.viewport,
    summary: `${interactiveElements.length} interactive elements in view model (${snapshot.nodeCount} total nodes).`,
    interactiveElements,
    potentialIssues
  };
}

function suggestedActionsForNode(node: AgentNode): SuggestedAction[] {
  const actions = new Set<SuggestedAction>();

  if (!node.enabled) {
    return [];
  }

  if (node.editable || node.role === "textbox") {
    actions.add("fill");
  }

  if (node.tag === "select" || node.role === "combobox" || node.role === "listbox") {
    actions.add("select");
  }

  if (node.interactive) {
    actions.add("click");
  }

  return [...actions];
}

function describeLocation(
  box: AgentNode["boundingBox"],
  viewportWidth: number,
  viewportHeight: number
): string {
  const inViewport = isBoxInViewport(box, viewportWidth, viewportHeight);
  if (!inViewport) {
    const horizontal = box.x + box.width < 0 ? "left" : box.x > viewportWidth ? "right" : "center";
    const vertical = box.y + box.height < 0 ? "above" : box.y > viewportHeight ? "below" : "middle";
    return `offscreen-${vertical}-${horizontal}`;
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  const horizontal = centerX < viewportWidth / 3 ? "left" : centerX > (viewportWidth * 2) / 3 ? "right" : "center";
  const vertical = centerY < viewportHeight / 3 ? "top" : centerY > (viewportHeight * 2) / 3 ? "bottom" : "middle";

  return `${vertical}-${horizontal}`;
}

function detectPotentialIssues(snapshot: DomSnapshot): string[] {
  const issues: string[] = [];

  const visibleInteractive = snapshot.nodes.filter((node) => node.interactive && node.visible);

  if (visibleInteractive.length === 0) {
    issues.push("No visible interactive elements were detected.");
    return issues;
  }

  const tinyTargets = visibleInteractive.filter(
    (node) => node.boundingBox.width < 24 || node.boundingBox.height < 24
  );
  if (tinyTargets.length > 0) {
    issues.push(`${tinyTargets.length} interactive elements have small hit areas (<24px).`);
  }

  const disabledInteractive = snapshot.nodes.filter((node) => node.interactive && !node.enabled);
  if (disabledInteractive.length > 0) {
    issues.push(`${disabledInteractive.length} interactive elements are disabled.`);
  }

  const offscreenInteractive = visibleInteractive.filter(
    (node) => !isBoxInViewport(node.boundingBox, snapshot.viewport.width, snapshot.viewport.height)
  );
  if (offscreenInteractive.length > 0) {
    issues.push(`${offscreenInteractive.length} interactive elements are currently outside the viewport.`);
  }

  const duplicateNameCount = countDuplicateInteractiveNames(visibleInteractive);
  if (duplicateNameCount > 0) {
    issues.push(`${duplicateNameCount} duplicate visible role/name combinations may cause ambiguous targeting.`);
  }

  const overlapCount = countOverlappingInteractiveElements(visibleInteractive.slice(0, 180));
  if (overlapCount > 0) {
    issues.push(`${overlapCount} overlapping interactive element pairs detected in viewport.`);
  }

  return issues;
}

function countDuplicateInteractiveNames(nodes: AgentNode[]): number {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = `${node.role}:${normalizeName(node.name || node.text)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let duplicates = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicates += 1;
    }
  }
  return duplicates;
}

function normalizeName(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function countOverlappingInteractiveElements(nodes: AgentNode[]): number {
  let overlaps = 0;

  for (let index = 0; index < nodes.length; index += 1) {
    for (let candidateIndex = index + 1; candidateIndex < nodes.length; candidateIndex += 1) {
      if (intersects(nodes[index].boundingBox, nodes[candidateIndex].boundingBox)) {
        overlaps += 1;
      }
    }
  }

  return overlaps;
}

function intersects(a: AgentNode["boundingBox"], b: AgentNode["boundingBox"]): boolean {
  const right = Math.min(a.x + a.width, b.x + b.width);
  const left = Math.max(a.x, b.x);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const top = Math.max(a.y, b.y);
  return right - left > 0 && bottom - top > 0;
}

function isBoxInViewport(
  box: AgentNode["boundingBox"],
  viewportWidth: number,
  viewportHeight: number
): boolean {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return right > 0 && bottom > 0 && box.x < viewportWidth && box.y < viewportHeight;
}

function scoreInteractionConfidence(
  node: AgentNode,
  viewportWidth: number,
  viewportHeight: number
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (node.visible) {
    score += 35;
    reasons.push("visible");
  }

  if (node.enabled) {
    score += 20;
    reasons.push("enabled");
  }

  if (isBoxInViewport(node.boundingBox, viewportWidth, viewportHeight)) {
    score += 20;
    reasons.push("in-viewport");
  }

  if (node.role !== "generic") {
    score += 10;
    reasons.push("semantic-role");
  }

  if ((node.name || node.text).trim().length > 0) {
    score += 10;
    reasons.push("named-or-textual");
  }

  const hitArea = node.boundingBox.width * node.boundingBox.height;
  if (hitArea >= 44 * 44) {
    score += 5;
    reasons.push("adequate-hit-area");
  }

  return {
    score,
    reasons
  };
}
