import { z } from "zod";

export const RawSchoolSchema = z.object({
  schoolName: z.string(),
  schoolType: z.string().nullable(),
  electorate: z.string(),
  decsRegion: z.string(),
  isGovernment: z.boolean(),
  itSchoolCode: z.string(),
  isPreSchool: z.boolean(),
  displayInternal: z.boolean(),
  displayExternal: z.boolean(),
});

export type RawSchool = z.infer<typeof RawSchoolSchema>;

export const RawSchoolArraySchema = z.array(RawSchoolSchema);

export interface SiteItem {
  name: string;
  schoolCode: string;
  region: string;
  remoteness: string;
  siteStatus: string;
  powerReady: string;
  commsReady: string;
  readinessScore: number;
}

export interface FilterResult {
  items: SiteItem[];
  totalCount: number;
  nonGovernmentCount: number;
  preSchoolFlagCount: number;
  preSchoolTypeCount: number;
  filteredCount: number;
}

export type LabelMap = Map<string, number>;

export interface BoardSchema {
  columns: Map<string, LabelMap>;
}

export interface IngestSummary {
  fetched: number;
  filtered: number;
  nonGovernmentExcluded: number;
  preSchoolFlagExcluded: number;
  preSchoolTypeExcluded: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  unmapped: number;
  orphans: string[];
}
