import assert from "node:assert/strict";
import { test } from "node:test";
import { searchEntities } from "../lib-hbase";

const encode = (value: string) => Buffer.from(value).toString("base64");
const row = (key: string, values: Record<string, string>) => ({
  key: encode(key),
  Cell: Object.entries(values).map(([column, value]) => ({ column: encode(`cf:${column}`), $: encode(value) })),
});

test("search combines filters case-insensitively and returns deterministic row-key order", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ Row: [
    row("z-sales", { type: "hive_table", name: "Sales Archive", owner: "Data-Platform", qualifiedName: "warehouse.sales_archive" }),
    row("a-sales", { type: "hive_table", name: "Sales Daily", owner: "Data-Platform", qualifiedName: "warehouse.sales_daily" }),
    row("b-other-owner", { type: "hive_table", name: "Sales Daily", owner: "Finance", qualifiedName: "warehouse.sales_daily" }),
    row("c-other-type", { type: "hdfs_path", name: "Sales Daily", owner: "Data-Platform", qualifiedName: "warehouse.sales_daily" }),
    row("d-other-name", { type: "hive_table", name: "Inventory", owner: "Data-Platform", qualifiedName: "warehouse.inventory" }),
  ] }));

  const results = await searchEntities({ q: "WAREHOUSE", type: "HIVE_TABLE", owner: "DATA-PLATFORM", name: "SALES" });
  assert.deepEqual(results.map(({ rowKey }) => rowKey), ["a-sales", "z-sales"]);
  assert.equal(results[0].name, "Sales Daily");
});
