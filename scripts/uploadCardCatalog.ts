import fs from 'node:fs';
import path from 'node:path';
import AWS from 'aws-sdk';
import type { EnrichedCardRecord } from '../src/card-catalog';

const TABLE_NAME = process.env.CARD_CATALOG_TABLE || 'riftbound-dev-card-catalog';
const REGION = process.env.AWS_REGION || 'us-east-1';
const SOURCE_PATH = path.resolve(process.cwd(), 'data', 'cards.enriched.json');
const BATCH_WRITE_LIMIT = 25;

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });
type WriteRequest = AWS.DynamoDB.DocumentClient.WriteRequest;

interface CardCatalogFile {
  cards: EnrichedCardRecord[];
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    output.push(items.slice(i, i + size));
  }
  return output;
};

const loadCards = (): EnrichedCardRecord[] => {
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(`Unable to locate ${SOURCE_PATH}`);
  }
  const raw = fs.readFileSync(SOURCE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as CardCatalogFile;
  if (!parsed.cards || !Array.isArray(parsed.cards)) {
    throw new Error('cards.enriched.json does not contain a cards array');
  }
  return parsed.cards;
};

const mapCardToItem = (card: EnrichedCardRecord) => {
  return {
    CardSlug: card.slug,
    CardId: card.id,
    CardName: card.name,
    CardType: card.type ?? null,
    CardRarity: card.rarity ?? null,
    SetName: card.setName ?? null,
    PrimaryDomain: card.colors[0] ?? 'neutral',
    Colors: card.colors,
    Tags: card.tags,
    Keywords: card.keywords,
    CardEffect: card.effect,
    Might: card.might,
    Cost: card.cost,
    ActivationProfile: card.activation,
    RuleClauses: card.rules,
    CardImageUrl: card.assets?.remote ?? null,
    CardImageLocalPath: card.assets?.localPath ?? null,
    Assets: card.assets,
    Pricing: card.pricing,
    References: card.references,
    LastIndexedAt: Date.now()
  };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const uploadBatch = async (items: WriteRequest[]) => {
  let unprocessed: WriteRequest[] | undefined = items;
  let attempts = 0;
  while (unprocessed && unprocessed.length > 0 && attempts < 5) {
    const params: AWS.DynamoDB.DocumentClient.BatchWriteItemInput = {
      RequestItems: {
        [TABLE_NAME]: unprocessed
      }
    };
    const response = await dynamodb.batchWrite(params).promise();
    unprocessed = response.UnprocessedItems?.[TABLE_NAME];
    if (unprocessed && unprocessed.length > 0) {
      attempts += 1;
      const backoffMs = attempts * 500;
      console.warn(
        `Batch write throttled (${unprocessed.length} items). Retrying in ${backoffMs}ms...`
      );
      await delay(backoffMs);
    } else {
      unprocessed = undefined;
    }
  }

  if (unprocessed && unprocessed.length > 0) {
    throw new Error(`Failed to write ${unprocessed.length} items after multiple retries`);
  }
};

const main = async () => {
  if (!TABLE_NAME) {
    throw new Error('CARD_CATALOG_TABLE env var must be defined');
  }

  const cards = loadCards();
  if (cards.length === 0) {
    console.log('No cards found to upload.');
    return;
  }

  console.log(`Uploading ${cards.length} cards to ${TABLE_NAME} in ${REGION}...`);
  const writeRequests: WriteRequest[] = cards.map((card) => ({
    PutRequest: {
      Item: mapCardToItem(card)
    }
  }));
  const batches = chunk(writeRequests, BATCH_WRITE_LIMIT);

  let processed = 0;
  for (const batch of batches) {
    await uploadBatch(batch);
    processed += batch.length;
    console.log(`✓ Uploaded ${processed}/${cards.length}`);
  }

  console.log('Card catalog upload complete.');
};

main().catch((error) => {
  console.error('Card upload failed:', error);
  process.exitCode = 1;
});
