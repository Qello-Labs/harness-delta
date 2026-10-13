ALTER TABLE source_compatibility_blocks RENAME TO previous_source_compatibility_blocks;
CREATE TABLE source_compatibility_blocks (
  product TEXT NOT NULL CHECK(product IN ('codex','claude_code')),
  product_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('file','codex_workflow','claude_workflow','codex_binding')),
  reason TEXT NOT NULL CHECK(reason IN ('contract_failed','semantic_incompatibility')),
  PRIMARY KEY(product, product_version, source)
);
INSERT INTO source_compatibility_blocks
SELECT product, product_version, source, reason FROM previous_source_compatibility_blocks;
DROP TABLE previous_source_compatibility_blocks;
