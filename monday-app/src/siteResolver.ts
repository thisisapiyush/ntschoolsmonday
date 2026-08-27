import type { MondayClient } from "./mondayClient.js";

interface ItemsPageResponse {
  boards: Array<{
    items_page: {
      cursor: string | null;
      items: Array<{ id: string; name: string }>;
    };
  }>;
}

export interface SiteMatch {
  kind: "matched";
  itemId: string;
  name: string;
}

export interface SiteUnresolved {
  kind: "unresolved";
  reason: string;
  parsedName: string | null;
}

export type SiteResolution = SiteMatch | SiteUnresolved;

const MIN_REFRESH_INTERVAL_MS = 60_000;

export function parseSchoolName(summary: string): string | null {
  const separatorIndex = summary.lastIndexOf(" - ");
  if (separatorIndex === -1) return null;
  const name = summary.slice(separatorIndex + 3).trim();
  return name.length > 0 ? name : null;
}

export function createSiteResolver(client: MondayClient, boardId: string) {
  let cache = new Map<string, string>();
  let lastRefresh = 0;

  function normalize(name: string): string {
    return name.toLowerCase().trim();
  }

  async function fetchPage(
    pageCursor: string | null
  ): Promise<ItemsPageResponse> {
    if (pageCursor) {
      return client.query<ItemsPageResponse>(
        `query ($boardId: [ID!]!, $cursor: String!) {
          boards(ids: $boardId) {
            items_page(limit: 100, cursor: $cursor) {
              cursor
              items { id name }
            }
          }
        }`,
        { boardId: [boardId], cursor: pageCursor }
      );
    }
    return client.query<ItemsPageResponse>(
      `query ($boardId: [ID!]!) {
        boards(ids: $boardId) {
          items_page(limit: 100) {
            cursor
            items { id name }
          }
        }
      }`,
      { boardId: [boardId] }
    );
  }

  async function loadSites(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor: string | null = null;
    let isFirstPage = true;

    while (isFirstPage || cursor) {
      isFirstPage = false;

      const data = await fetchPage(cursor);
      const page = data.boards[0]?.items_page;
      if (!page) break;

      for (const item of page.items) {
        const key = normalize(item.name);
        if (!map.has(key)) {
          map.set(key, item.id);
        }
      }

      cursor = page.cursor;
    }

    return map;
  }

  async function ensureLoaded(): Promise<void> {
    if (cache.size === 0) {
      cache = await loadSites();
      lastRefresh = Date.now();
    }
  }

  async function refreshIfAllowed(): Promise<boolean> {
    const now = Date.now();
    if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
      return false;
    }
    cache = await loadSites();
    lastRefresh = now;
    return true;
  }

  async function resolve(summary: string): Promise<SiteResolution> {
    await ensureLoaded();

    const parsedName = parseSchoolName(summary);
    if (!parsedName) {
      return {
        kind: "unresolved",
        reason: `Summary does not contain " - " separator: "${summary}"`,
        parsedName: null,
      };
    }

    const key = normalize(parsedName);

    let itemId = cache.get(key);
    if (itemId) {
      return { kind: "matched", itemId, name: parsedName };
    }

    const refreshed = await refreshIfAllowed();
    if (refreshed) {
      itemId = cache.get(key);
      if (itemId) {
        return { kind: "matched", itemId, name: parsedName };
      }
    }

    return {
      kind: "unresolved",
      reason: `No site found matching "${parsedName}"`,
      parsedName,
    };
  }

  return { resolve, parseSchoolName };
}

export type SiteResolver = ReturnType<typeof createSiteResolver>;
