import { RawSchoolArraySchema, type RawSchool } from "./types.js";

const SOURCE_URL =
  "https://directory.ntschools.net/api/School/GetAllSchoolsForDirectory";

export async function fetchSchools(): Promise<RawSchool[]> {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(
      `Source API returned ${response.status} ${response.statusText} from ${SOURCE_URL}`
    );
  }
  const data: unknown = await response.json();
  return RawSchoolArraySchema.parse(data);
}
