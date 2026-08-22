import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import { graphOverview, jsonResult } from "./queries";

export async function handleCurationGraphOverview(db: Kysely<DB>) {
  return jsonResult(await graphOverview(db));
}
