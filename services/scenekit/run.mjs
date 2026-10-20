// Runs one scene in headless Chromium and reports what it did.
// stdin:  {host_html, width, height, steps: [{op: "wait_ready"|"set"|"settle"|"mark"|"screenshot", ...}], timeout_ms}
// stdout: {ok, error?, log, marks, screenshot_b64, pixels: {stdev, colors}, page_errors}
// Browser: SEEDOTS_CHROME (path) > installed Google Chrome > Playwright's Chromium.
async function loadPlaywright() {
  for (const name of ["playwright-core", "playwright"]) {
    try { return await import(name); } catch { /* try next */ }
  }
  const base = process.env.NODE_PATH?.split(":")[0];
  if (base) return import(`${base}/playwright/index.mjs`);
  throw new Error("playwright-core is not installed (cd services/scenekit && npm install)");
}

async function launch(pw) {
  const chromium = pw.chromium ?? pw.default?.chromium;
  const opts = { headless: true, args: ["--disable-gpu", "--no-sandbox"] };
  if (process.env.SEEDOTS_CHROME) return chromium.launch({ ...opts, executablePath: process.env.SEEDOTS_CHROME });
  try { return await chromium.launch({ ...opts, channel: "chrome" }); } catch { /* fall back */ }
  return chromium.launch(opts);
}

const input = JSON.parse(await new Promise((res) => {
  let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s));
}));
const out = { ok: false, log: [], marks: {}, page_errors: [], screenshot_b64: null, pixels: null };
let browser;
const deadline = Date.now() + (input.timeout_ms || 20000);
try {
  const pw = await loadPlaywright();
  browser = await launch(pw);
  const page = await browser.newPage({ viewport: { width: input.width + 20, height: input.height + 20 } });
  page.on("pageerror", (e) => out.page_errors.push(String(e.message)));
  await page.setContent(input.host_html, { waitUntil: "load" });
  const log = () => page.evaluate(() => window.__log);
  for (const step of input.steps) {
    if (Date.now() > deadline) throw new Error("scene took too long");
    if (step.op === "wait_ready") {
      const until = Date.now() + (step.timeout || 6000);
      while (!(await log()).some((m) => m.type === "ready")) {
        if (Date.now() > until) throw new Error("the scene never called kit.ready()");
        await page.waitForTimeout(50);
      }
    } else if (step.op === "set") {
      // wait for the scene's acknowledgement (its onChange handlers ran and their
      // observations were posted before it), so results never depend on machine speed
      const seen = (await log()).length;
      await page.evaluate(([n, v]) => window.__set(n, v), [step.name, step.value]);
      const until = Date.now() + 3000;
      while (!(await log()).slice(seen).some((m) => m.type === "ack" && m.name === step.name)) {
        if (Date.now() > until) break;          // unhandled: the gate reports it
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(step.settle ?? 60);
    } else if (step.op === "settle") {
      await page.waitForTimeout(step.ms || 200);
    } else if (step.op === "mark") {
      out.marks[step.label] = (await log()).length;
    } else if (step.op === "screenshot") {
      const buf = await page.locator("#scene").screenshot();
      out.screenshot_b64 = buf.toString("base64");
      out.pixels = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0, sum = 0, sq = 0; const colors = new Set();
        for (let i = 0; i < d.length; i += 4 * 7) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sum += l; sq += l * l; n++;
          if (colors.size < 512) colors.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4));
        }
        const mean = sum / n;
        return { stdev: Math.sqrt(Math.max(0, sq / n - mean * mean)), colors: colors.size };
      }, out.screenshot_b64);
    }
  }
  out.log = await log();
  out.ok = true;
} catch (e) {
  out.error = String(e && e.message || e);
} finally {
  if (browser) await browser.close().catch(() => {});
}
process.stdout.write(JSON.stringify(out));
