import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = "https://piltoverarchive.com/cards";
const DEFAULT_TARGET_CARDS = 673;
const TARGET_CARDS = Number(process.env.TARGET_CARDS ?? DEFAULT_TARGET_CARDS);
const OUTPUT_FILE = path.join(ROOT, 'data', 'piltover-archive.json');

const ensureDir = (filepath: string) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

type CardRecord = {
  name: string;
  set_code: string | null;
  collector_number: string | null;
  collector_string: string | null;
  energy_cost: number | null;
  power_cost: number | null;
  power_type: string | null;
  might: number | null;
  card_type: string | null;
  image_url: string | null;
};

type ModalExtraction = {
  name: string | null;
  cardType: string | null;
  powerType: string | null;
  stats: Record<string, string>;
  info: Record<string, string>;
  imageUrl: string | null;
};

function parseCollectorParts(collector: string | null): {
  set_code: string | null;
  collector_number: string | null;
} {
  if (!collector) {
    return { set_code: null, collector_number: null };
  }
  const [setCode, ...rest] = collector.split("-");
  const suffix = rest.join("-") || null;
  return {
    set_code: setCode?.toUpperCase() ?? null,
    collector_number: suffix,
  };
}

function toNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function extractModalData(page: Page): Promise<ModalExtraction> {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    if (!dialog) {
      return {
        name: null,
        cardType: null,
        powerType: null,
        stats: {},
        info: {},
        imageUrl: null,
      };
    }

    const getText = (selector: string) => dialog.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? null;

    const badgeGroups = dialog.querySelectorAll("div.flex.flex-wrap.gap-2");
    const mainBadges = badgeGroups[0]?.querySelectorAll("[data-slot='badge']") ?? [];

    const stats: Record<string, string> = {};
    dialog.querySelectorAll("div.flex.justify-between div.flex.flex-col").forEach((entry) => {
      const label = entry.querySelector("p.text-muted-foreground")?.textContent?.trim();
      const value = entry.querySelector("p.text-4xl")?.textContent?.trim();
      if (label && value) {
        stats[label.toLowerCase()] = value;
      }
    });

    const info: Record<string, string> = {};
    dialog.querySelectorAll("div.space-y-1 div.flex.gap-1").forEach((row) => {
      const spans = row.querySelectorAll("span");
      if (spans.length >= 2) {
        const label = spans[0].textContent?.replace(":", "").trim().toLowerCase();
        const value = spans[1].textContent?.trim();
        if (label && value) {
          info[label] = value;
        }
      }
    });

    const name = getText("[data-slot='dialog-title']");
    const cardType = mainBadges[0]?.textContent?.trim() ?? null;
    const powerType = mainBadges[2]?.textContent?.trim() ?? null;
    const imageUrl =
      dialog.querySelector<HTMLImageElement>("div img[data-nimg='fill']")?.currentSrc ||
      dialog.querySelector<HTMLImageElement>("div img[data-nimg='fill']")?.src ||
      null;

    return {
      name,
      cardType,
      powerType,
      stats,
      info,
      imageUrl,
    };
  });
}

async function scrapeCard(page: Page, triggerIndex: number): Promise<CardRecord | null> {
  const trigger = page.locator("div[aria-haspopup='dialog']").nth(triggerIndex);
  const count = await page.locator("div[aria-haspopup='dialog']").count();
  if (triggerIndex >= count) return null;

  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.waitForSelector("[role='dialog']");

  const modal = await extractModalData(page);

  const energy_cost = toNumber(modal.stats["energy"]);
  const power_cost = toNumber(modal.stats["power"]);
  const might = toNumber(modal.stats["might"]);
  const collector_string = modal.info["card number"] ?? null;
  const { set_code, collector_number } = parseCollectorParts(collector_string);

  const record: CardRecord = {
    name: modal.name ?? `Card ${triggerIndex + 1}`,
    set_code,
    collector_number,
    collector_string,
    energy_cost,
    power_cost,
    power_type: modal.powerType,
    might,
    card_type: modal.cardType,
    image_url: modal.imageUrl,
  };

  // Close modal and wait for it to disappear
  await page.locator("[data-slot='dialog-close']").click();
  await page.waitForSelector("[role='dialog']", { state: "detached" });

  return record;
}

async function getFirstCardKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>("div[aria-haspopup='dialog'] img");
    if (!img) return null;
    const alt = img.getAttribute("alt") ?? "";
    const src = img.currentSrc || img.getAttribute("src") || "";
    return `${alt}::${src}`;
  });
}

async function waitForGridChange(page: Page, previousKey: string | null) {
  if (!previousKey) {
    await page.waitForTimeout(500);
    return;
  }
  try {
    await page.waitForFunction(
      (prev) => {
        const img = document.querySelector<HTMLImageElement>("div[aria-haspopup='dialog'] img");
        if (!img) return false;
        const alt = img.getAttribute("alt") ?? "";
        const src = img.currentSrc || img.getAttribute("src") || "";
        const key = `${alt}::${src}`;
        return key && key !== prev;
      },
      previousKey,
      { timeout: 20_000 }
    );
  } catch {
    // Ignore timeout – cards may have reloaded but kept same first key.
  }
}

async function main() {
  // Check if piltover-archive.json already exists and is non-empty
  const forceRefresh = process.argv.includes('--force');
  if (!forceRefresh && fs.existsSync(OUTPUT_FILE)) {
    try {
      const content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ Skipping scrape: ${OUTPUT_FILE} already exists with ${data.length} cards.`);
        console.log(`   (Use --force to re-scrape)`);
        return;
      }
    } catch {
      // File exists but is invalid, proceed with scraping
    }
  }

  console.log(`🔍 Capturing first ${TARGET_CARDS} cards from Piltover Archive…`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("div[aria-haspopup='dialog']");

  const records: CardRecord[] = [];
  let pageIndex = 1;

  while (records.length < TARGET_CARDS) {
    await page.waitForSelector("div[aria-haspopup='dialog']");
    const cardTriggers = page.locator("div[aria-haspopup='dialog']");
    const cardsOnPage = await cardTriggers.count();

    if (cardsOnPage === 0) {
      console.log("⚠️  No cards detected on this page; stopping.");
      break;
    }

    console.log(`\n📄 Page ${pageIndex}: ${cardsOnPage} cards detected.`);
    for (let i = 0; i < cardsOnPage && records.length < TARGET_CARDS; i++) {
      try {
        console.log(`  • Extracting card ${records.length + 1}/${TARGET_CARDS}…`);
        const card = await scrapeCard(page, i);
        if (card) {
          records.push(card);
        }
      } catch (err) {
        console.error(`    ✖ Failed to scrape card index ${i} on page ${pageIndex}:`, err);
      }
    }

    console.log(`✅ Completed page ${pageIndex}; total captured so far: ${records.length}`);
    if (records.length >= TARGET_CARDS) break;

    const nextLink = page.locator("a[aria-label='Go to next page']").first();
    const hasNext = await nextLink.count();
    const href = hasNext ? await nextLink.getAttribute("href") : null;
    const ariaDisabled = hasNext ? await nextLink.getAttribute("aria-disabled") : null;

    if (!hasNext || !href || ariaDisabled === "true") {
      console.log("⛔ No additional pages available. Stopping.");
      break;
    }

    console.log("➡️  Moving to next page…");
    const previousKey = await getFirstCardKey(page);
    await nextLink.click();
    await waitForGridChange(page, previousKey);
    await page.waitForSelector("div[aria-haspopup='dialog']");
    pageIndex++;
  }

  await browser.close();

  ensureDir(OUTPUT_FILE);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
  console.log(`\n✅ Saved ${records.length} cards to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Scraper failed:", err);
  process.exit(1);
});
