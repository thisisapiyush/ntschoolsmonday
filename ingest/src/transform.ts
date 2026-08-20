import type { RawSchool, SiteItem, FilterResult } from "./types.js";
import { readinessScore } from "./readiness.js";

/**
 * Remoteness is a proxy — the source has no remoteness field.
 * Derived from schoolType and decsRegion as follows:
 *   schoolType "Remote School" or "Small School" -> "Very Remote"
 *   schoolType "Distance School"                 -> "Remote"
 *   otherwise, decsRegion "Darwin"               -> "Urban"
 *   otherwise                                    -> "Regional"
 */
export function deriveRemoteness(
  schoolType: string | null,
  decsRegion: string
): string {
  if (schoolType === "Remote School" || schoolType === "Small School") {
    return "Very Remote";
  }
  if (schoolType === "Distance School") {
    return "Remote";
  }
  if (decsRegion === "Darwin") {
    return "Urban";
  }
  return "Regional";
}

export function filterAndTransform(schools: RawSchool[]): FilterResult {
  const totalCount = schools.length;

  let nonGovernmentCount = 0;
  let preSchoolFlagCount = 0;
  let preSchoolTypeCount = 0;

  const items: SiteItem[] = [];

  for (const school of schools) {
    if (!school.isGovernment) {
      nonGovernmentCount++;
      continue;
    }
    if (school.isPreSchool) {
      preSchoolFlagCount++;
      continue;
    }
    if (school.schoolType === "Preschool") {
      preSchoolTypeCount++;
      continue;
    }

    const remoteness = deriveRemoteness(school.schoolType, school.decsRegion);
    const siteStatus = "Not started";
    const powerReady = "Unknown";
    const commsReady = "Unknown";

    items.push({
      name: school.schoolName,
      schoolCode: school.itSchoolCode,
      region: school.decsRegion,
      remoteness,
      siteStatus,
      powerReady,
      commsReady,
      readinessScore: readinessScore(powerReady, commsReady, siteStatus),
    });
  }

  return {
    items,
    totalCount,
    nonGovernmentCount,
    preSchoolFlagCount,
    preSchoolTypeCount,
    filteredCount: items.length,
  };
}
