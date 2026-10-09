import pg from "pg";
import { config } from "./config.js";

// bigint (int8) and count(*) come back as strings by default; our values fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  options: "-c timezone=UTC",
});
