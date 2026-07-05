import { ClaimStore } from "../src/storage.js";
import { EmbeddingService } from "../src/embeddings.js";

const claimStore = new ClaimStore(process.env.DATABASE_URL!);
const embed = new EmbeddingService({
  provider: (process.env.EMBEDDING_PROVIDER as "ollama") || "ollama",
  baseUrl: process.env.OLLAMA_URL || process.env.OLLAMA_HOST,
});

const client = await claimStore.connect();
const { rows } = await client.query(`
  SELECT c.id, c.claim_text
  FROM extracted_claims c
  LEFT JOIN content_embeddings e ON e.content_id = c.id
  WHERE e.id IS NULL
  ORDER BY c.extracted_at DESC NULLS LAST
  LIMIT 200
`);
console.log(`Claims missing embeddings: ${rows.length}`);
let ok = 0;
for (const row of rows) {
  try {
    const vec = await embed.embed(row.claim_text);
    await claimStore.storeEmbedding(row.id, row.claim_text, vec, client);
    ok++;
    if (ok % 25 === 0) console.log(`  embedded ${ok}/${rows.length}`);
  } catch (e) {
    console.warn(`skip ${row.id}:`, e);
  }
}
console.log(`Done: ${ok} embeddings stored`);
await client.end();