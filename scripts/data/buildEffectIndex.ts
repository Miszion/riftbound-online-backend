import fs from 'node:fs';
import path from 'node:path';
import { effectClassDefinitions, getCardCatalog } from '../../src/card-catalog';

const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'effect-taxonomy.json');

const ensureDir = (filepath: string) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const main = () => {
  const catalog = getCardCatalog();
  const classCounts: Record<string, number> = {};
  effectClassDefinitions.forEach((definition) => {
    classCounts[definition.id] = 0;
  });

  const cards = catalog.map((card) => {
    const uniqueClasses = new Set(card.effectProfile.classes);
    uniqueClasses.forEach((id) => {
      classCounts[id] = (classCounts[id] ?? 0) + 1;
    });
    return {
      id: card.id,
      slug: card.slug,
      name: card.name,
      classes: card.effectProfile.classes,
      operations: card.effectProfile.operations.map((operation) => operation.type),
      priority: card.effectProfile.priority,
      targeting: card.effectProfile.targeting
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    totalCards: catalog.length,
    classes: effectClassDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      ruleRefs: definition.ruleRefs
    })),
    classCounts,
    cards
  };

  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[effect-taxonomy] Wrote ${catalog.length} cards to ${OUTPUT_PATH}`);
};

main();
