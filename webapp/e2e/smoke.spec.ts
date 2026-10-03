import { expect, test } from "@playwright/test";

test("renders catalog data returned by the search API", async ({ page }) => {
  await page.route("**/api/search?**", async (route) => {
    await route.fulfill({ json: { results: [{
      rowKey: "sales", type: "hive_table", name: "Sales Daily", owner: "Data-Platform",
      qualifiedName: "warehouse.sales_daily", createTime: "2026-01-01T00:00:00Z",
    }], count: 1, types: ["hive_table"] } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas Metadata Search" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Sales Daily", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Data-Platform", exact: true })).toBeVisible();
});
