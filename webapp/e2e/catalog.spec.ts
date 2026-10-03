import { expect, test, type Page } from "@playwright/test";

const entity = (name = "sales", type = "hive_table") => ({ rowKey: name, type, name, owner: "platform", qualifiedName: `warehouse.${name}`, createTime: "2026-01-01" });
const catalogTypes = ["spark_job", "hive_table", "hdfs_path", "hive_database"];
const response = (name = "sales") => ({ results: [entity(name)], count: 1, types: catalogTypes });

async function mockSearch(page: Page) {
  await page.route("**/api/search?*", route => route.fulfill({ json: response() }));
}

// This fetch intentionally ignores abort to model a server/body promise completing late.
// Regression tests must exercise the request identity check as well as cancellation.
async function deferredSearch(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const state = { pending: {} as Record<string, { resolve: (value: Response) => void; reject: (reason: Error) => void }>, aborted: [] as string[] };
    Object.assign(window, { searchTest: state });
    window.fetch = (input, init) => {
      const url = new URL(String(input), location.href);
      if (url.pathname !== "/api/search") return originalFetch(input, init);
      const q = url.searchParams.get("q") || "";
      if (!q) return Promise.resolve(new Response(JSON.stringify({ results: [], count: 0, types: [] })));
      init?.signal?.addEventListener("abort", () => state.aborted.push(q));
      return new Promise<Response>((resolve, reject) => { state.pending[q] = { resolve, reject }; });
    };
  });
}

async function settleSearch(page: Page, q: string, result: "success" | "http-error" | "network-error", flush = true) {
  await page.evaluate(({ q, result, payload }) => {
    const state = (window as unknown as { searchTest: { pending: Record<string, { resolve: (value: Response) => void; reject: (reason: Error) => void }> } }).searchTest;
    if (result === "network-error") state.pending[q].reject(new Error("Obsolete network error"));
    else state.pending[q].resolve(new Response(JSON.stringify(result === "http-error" ? { error: "Obsolete HTTP error" } : payload), { status: result === "http-error" ? 502 : 200 }));
  }, { q, result, payload: response(q) });
  // Flush promise continuations and React rendering before checking for stale updates.
  if (flush) await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function waitForSearch(page: Page, q: string) {
  await expect.poll(() => page.evaluate(q => Boolean((window as unknown as { searchTest: { pending: Record<string, unknown> } }).searchTest.pending[q]), q)).toBe(true);
}

test("initial, loading, empty, error and recovered success have truthful accessible states", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/search?*", async route => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "failed") return route.fulfill({ status: 502, json: { error: "HBase REST is unavailable" } });
    if (!q) { await gate; return route.fulfill({ json: { results: [], count: 0, types: catalogTypes } }); }
    return route.fulfill({ json: response() });
  });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Atlas metadata search results" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("HBase REST reachable")).toHaveCount(0);
  await expect(page.getByText("No matching metadata.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Search metadata", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Owner", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name contains", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).focus();
  await expect(page.getByRole("button", { name: "Reset filters" })).toBeFocused();
  const outline = await page.getByRole("button", { name: "Reset filters" }).evaluate(element => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  release();
  await expect(page.getByText("No matching metadata.")).toBeVisible();
  await expect(page.getByText("HBase REST reachable")).toBeVisible();
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("failed");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("HBase REST is unavailable");
  await expect(page.getByText("HBase REST unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No matching metadata.")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("sales");
  await expect(page.getByRole("cell", { name: "sales", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

for (const obsolete of ["success", "http-error", "network-error"] as const) {
  test(`late obsolete ${obsolete} cannot replace newest result even if fetch ignores abort`, async ({ page }) => {
    await deferredSearch(page);
    await page.goto("/");
    await expect(page.getByText("No matching metadata.")).toBeVisible();
    await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("obsolete");
    await waitForSearch(page, "obsolete");
    await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("newest");
    await waitForSearch(page, "newest");
    await settleSearch(page, "newest", "success");
    await expect(page.getByRole("cell", { name: "newest", exact: true })).toBeVisible();
    await settleSearch(page, "obsolete", obsolete);
    await expect.poll(() => page.evaluate(() => (window as unknown as { searchTest: { aborted: string[] } }).searchTest.aborted)).toContain("obsolete");
    await expect(page.getByRole("cell", { name: "newest", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "obsolete", exact: true })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });
}

test("obsolete success cannot clear a newer error", async ({ page }) => {
  await deferredSearch(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("obsolete");
  await waitForSearch(page, "obsolete");
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("newest");
  await waitForSearch(page, "newest");
  await settleSearch(page, "newest", "http-error");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Obsolete HTTP error");
  await settleSearch(page, "obsolete", "success");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Obsolete HTTP error");
  await expect(page.getByRole("cell", { name: "obsolete", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
});

test("URL restores filters and fourth catalog type across reload, Back, Forward and reset", async ({ page }) => {
  await mockSearch(page);
  await page.goto("/?q=first&type=custom_type&campaign=keep#catalog");
  await expect(page.getByRole("textbox", { name: "Search metadata", exact: true })).toHaveValue("first");
  await expect(page.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("custom_type");
  await expect(page.getByRole("cell", { name: "sales", exact: true })).toBeVisible();
  expect(await page.getByRole("combobox", { name: "Type", exact: true }).locator("option").allTextContents()).toEqual(["All types", "custom_type", "hdfs_path", "hive_database", "hive_table", "spark_job"]);
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("spark_job");
  await page.getByLabel("Owner", { exact: true }).fill("platform");
  await page.getByLabel("Name contains", { exact: true }).fill("sales");
  await page.reload();
  await expect(page.getByLabel("Owner", { exact: true })).toHaveValue("platform");
  await expect(page.getByLabel("Name contains", { exact: true })).toHaveValue("sales");
  await expect(page.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("spark_job");
  await page.goBack();
  await expect(page.getByLabel("Name contains", { exact: true })).toHaveValue("");
  await page.goForward();
  await expect(page.getByLabel("Name contains", { exact: true })).toHaveValue("sales");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\?campaign=keep#catalog$/);
  for (const label of ["Search metadata", "Owner", "Name contains", "Type"]) await expect(page.getByRole(label === "Type" ? "combobox" : "textbox", { name: label, exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  // A second reset is a no-op, not a permanently pending search.
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.goBack();
  await expect(page.getByLabel("Name contains", { exact: true })).toHaveValue("sales");
  await expect(page).toHaveURL(/campaign=keep/);
});

test("CSV export uses completed filters, shows progress/errors and releases download URLs", async ({ page }) => {
  await mockSearch(page);
  await page.addInitScript(() => {
    const state = { created: [] as string[], revoked: [] as string[] };
    Object.assign(window, { downloadsTest: state });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
  });
  let release!: () => void;
  let fail = true;
  let exportedQuery = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/export.csv?*", async route => {
    exportedQuery = new URL(route.request().url()).search;
    if (fail) { await gate; return route.fulfill({ status: 503, json: { error: "CSV service unavailable" } }); }
    return route.fulfill({ contentType: "text/csv", body: 'name\r\n"sales"\r\n' });
  });
  await page.goto("/?q=sales&owner=platform");
  const exportButton = page.getByRole("button", { name: "Export CSV", exact: true });
  await expect(exportButton).toBeEnabled();
  const before = page.url();
  await exportButton.click();
  await expect(page.getByRole("button", { name: "Exporting CSV…" })).toBeDisabled();
  await expect(page.getByText("Preparing CSV download…")).toBeVisible();
  release();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("CSV service unavailable");
  await expect(exportButton).toBeEnabled();
  expect(page.url()).toBe(before);
  fail = false;
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("atlas-metadata.csv");
  expect(new URLSearchParams(exportedQuery).get("q")).toBe("sales");
  expect(new URLSearchParams(exportedQuery).get("owner")).toBe("platform");
  await expect(page.getByText("CSV download started.")).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as { downloadsTest: { created: string[]; revoked: string[] } }).downloadsTest;
    return state.created.length === 1 && state.created[0] === state.revoked[0];
  })).toBe(true);
  expect(page.url()).toBe(before);
});

test("changing filters immediately disables export until matching results arrive", async ({ page }) => {
  await deferredSearch(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("newest");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await waitForSearch(page, "newest");
  await settleSearch(page, "newest", "success");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
});

test("changing filters cancels an in-flight CSV and discards its late download", async ({ page }) => {
  await mockSearch(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const state = { resolve: null as null | ((value: Response) => void), aborted: false, urls: 0 };
    Object.assign(window, { exportTest: state });
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { state.urls += 1; return create(blob); };
    window.fetch = (input, init) => {
      if (!String(input).startsWith("/api/export.csv")) return originalFetch(input, init);
      init?.signal?.addEventListener("abort", () => { state.aborted = true; });
      return new Promise<Response>(resolve => { state.resolve = resolve; });
    };
  });
  await page.goto("/?q=sales");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText("Preparing CSV download…")).toBeVisible();
  await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("changed");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.evaluate(() => {
    const state = (window as unknown as { exportTest: { resolve: (value: Response) => void } }).exportTest;
    state.resolve(new Response("name\r\nsales\r\n", { headers: { "content-type": "text/csv" } }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { exportTest: { aborted: boolean } }).exportTest.aborted)).toBe(true);
  await expect(page.getByText("CSV download started.")).toHaveCount(0);
  await expect(page.getByText("Preparing CSV download…")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { exportTest: { urls: number } }).exportTest.urls)).toBe(0);
});

for (const obsolete of ["success", "http-error"] as const) {
  test(`obsolete ${obsolete} during the new debounce cannot end loading or enable export`, async ({ page }) => {
    await deferredSearch(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto("/");
    await page.clock.runFor(200);
    await expect(page.getByText("No matching metadata.")).toBeVisible();
    await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("obsolete");
    await page.clock.runFor(200);
    await waitForSearch(page, "obsolete");
    await page.getByRole("textbox", { name: "Search metadata", exact: true }).fill("newest");
    await settleSearch(page, "obsolete", obsolete, false);
    await page.clock.runFor(40);
    expect(await page.evaluate(() => Boolean((window as unknown as { searchTest: { pending: Record<string, unknown> } }).searchTest.pending.newest))).toBe(false);
    await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await expect(page.getByRole("cell", { name: "obsolete", exact: true })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.clock.runFor(200);
    await waitForSearch(page, "newest");
    await settleSearch(page, "newest", "success", false);
    await page.clock.runFor(40);
    await expect(page.getByRole("cell", { name: "newest", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });
}

test("rapid typing shares one history entry while settled searches, select and reset remain distinct", async ({ page }) => {
  await mockSearch(page);
  await page.goto("/?q=settled&campaign=keep#catalog");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  const queryInput = page.getByRole("textbox", { name: "Search metadata", exact: true });
  await queryInput.fill("");
  await queryInput.pressSequentially("updated", { delay: 20 });
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await expect(page).toHaveURL(/q=updated/);
  await page.goBack();
  await expect(queryInput).toHaveValue("settled");
  await expect(page).toHaveURL(/campaign=keep#catalog$/);
  await page.goForward();
  await expect(queryInput).toHaveValue("updated");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await queryInput.fill("");
  await queryInput.pressSequentially("second", { delay: 20 });
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.goBack();
  await expect(queryInput).toHaveValue("updated");
  await page.goForward();
  await expect(queryInput).toHaveValue("second");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("spark_job");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(queryInput).toHaveValue("");
  await page.goBack();
  await expect(queryInput).toHaveValue("second");
  await expect(page.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("spark_job");
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("");
  await expect(queryInput).toHaveValue("second");
});
