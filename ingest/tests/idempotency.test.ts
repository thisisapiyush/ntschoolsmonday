import { describe, it, expect } from "vitest";
import type { SiteItem } from "../src/types.js";

interface ExistingItem {
  id: string;
  name: string;
  schoolCode: string;
}

function partitionItems(
  items: SiteItem[],
  existingMap: Map<string, ExistingItem>
): {
  toCreate: SiteItem[];
  toUpdate: Array<{ item: SiteItem; existingId: string }>;
  orphans: ExistingItem[];
} {
  const remaining = new Map(existingMap);
  const toCreate: SiteItem[] = [];
  const toUpdate: Array<{ item: SiteItem; existingId: string }> = [];

  for (const item of items) {
    const existing = remaining.get(item.schoolCode);
    if (existing) {
      toUpdate.push({ item, existingId: existing.id });
      remaining.delete(item.schoolCode);
    } else {
      toCreate.push(item);
    }
  }

  return {
    toCreate,
    toUpdate,
    orphans: [...remaining.values()],
  };
}

function makeSiteItem(overrides: Partial<SiteItem> & { schoolCode: string; name: string }): SiteItem {
  return {
    region: "Darwin",
    remoteness: "Urban",
    siteStatus: "Not started",
    powerReady: "Unknown",
    commsReady: "Unknown",
    readinessScore: 0,
    ...overrides,
  };
}

describe("idempotency partitioning", () => {
  it("creates new items that don't exist in monday", () => {
    const items: SiteItem[] = [
      makeSiteItem({ name: "School A", schoolCode: "scha" }),
      makeSiteItem({ name: "School B", schoolCode: "schb" }),
    ];
    const existing = new Map<string, ExistingItem>();

    const { toCreate, toUpdate, orphans } = partitionItems(items, existing);

    expect(toCreate).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
    expect(orphans).toHaveLength(0);
  });

  it("updates items that already exist in monday", () => {
    const items: SiteItem[] = [
      makeSiteItem({ name: "School A", schoolCode: "scha" }),
    ];
    const existing = new Map<string, ExistingItem>([
      ["scha", { id: "123", name: "School A", schoolCode: "scha" }],
    ]);

    const { toCreate, toUpdate, orphans } = partitionItems(items, existing);

    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0]?.existingId).toBe("123");
    expect(orphans).toHaveLength(0);
  });

  it("detects orphans in monday not present in source", () => {
    const items: SiteItem[] = [
      makeSiteItem({ name: "School A", schoolCode: "scha" }),
    ];
    const existing = new Map<string, ExistingItem>([
      ["scha", { id: "123", name: "School A", schoolCode: "scha" }],
      ["schx", { id: "456", name: "Closed School", schoolCode: "schx" }],
    ]);

    const { toCreate, toUpdate, orphans } = partitionItems(items, existing);

    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.name).toBe("Closed School");
  });

  it("handles a mix of create, update, and orphan", () => {
    const items: SiteItem[] = [
      makeSiteItem({ name: "Existing School", schoolCode: "exist" }),
      makeSiteItem({ name: "New School", schoolCode: "newone" }),
    ];
    const existing = new Map<string, ExistingItem>([
      ["exist", { id: "100", name: "Existing School", schoolCode: "exist" }],
      ["gone", { id: "200", name: "Gone School", schoolCode: "gone" }],
    ]);

    const { toCreate, toUpdate, orphans } = partitionItems(items, existing);

    expect(toCreate).toHaveLength(1);
    expect(toCreate[0]?.schoolCode).toBe("newone");
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0]?.existingId).toBe("100");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.name).toBe("Gone School");
  });

  it("re-running with the same data produces all updates and no creates", () => {
    const items: SiteItem[] = [
      makeSiteItem({ name: "School A", schoolCode: "scha" }),
      makeSiteItem({ name: "School B", schoolCode: "schb" }),
    ];
    const existing = new Map<string, ExistingItem>([
      ["scha", { id: "1", name: "School A", schoolCode: "scha" }],
      ["schb", { id: "2", name: "School B", schoolCode: "schb" }],
    ]);

    const { toCreate, toUpdate, orphans } = partitionItems(items, existing);

    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(2);
    expect(orphans).toHaveLength(0);
  });
});
