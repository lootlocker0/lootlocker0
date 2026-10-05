/**
 * Shared by every suite's prepareSchema() (tests/setup/db.ts,
 * tests/e2e/setup/db.ts, tests/stripe-real/db.ts). NOT a production table —
 * it appears in none of prisma/schema.prisma or prisma/migrations/*, and
 * exists only in a test database. See lib/pickup-windows-test.ts for why the
 * suite needs it: a freely-insertable, isolated, arbitrary-capacity window
 * per test, which the fixed production template can't express. Capacity
 * enforcement itself still only ever counts live `orders` rows — this table
 * holds nothing but a test's own declared label/capacity.
 */
export const TEST_PICKUP_WINDOWS_DDL =
  "CREATE TABLE IF NOT EXISTS test_pickup_windows (" +
  "service_date TIMESTAMP(3) NOT NULL, " +
  "start_time TEXT NOT NULL, " +
  "location TEXT NOT NULL, " +
  "label TEXT NOT NULL, " +
  "capacity INT NOT NULL, " +
  "PRIMARY KEY (service_date, start_time, location))";
