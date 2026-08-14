import { createHash } from "node:crypto";

function hashPayload(payload) {
  const { content_hash, ...body } = payload ?? {};
  const actual = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (!content_hash || content_hash !== actual || body.schema_version !== 1 || !Array.isArray(body.instrument_protection) || !Array.isArray(body.config)) throw new Error("INVALID_IMPORT_ARTIFACT");
  return { body, contentHash: content_hash };
}

export async function importOfflineProtection(client, artifact, { injectFailure = false } = {}) {
  const { body, contentHash } = hashPayload(artifact);
  const report = { input_hash: contentHash, schema_version: body.schema_version, inserted: 0, unchanged: 0, conflict: 0, config_artifact_hash: contentHash };
  await client.query("BEGIN");
  try {
    for (const row of body.instrument_protection) {
      if (row.state !== "BLACKLISTED") throw new Error("INVALID_PROTECTION_STATE");
      const result = await client.query(`INSERT INTO instrument_protection(inst_id,base_ccy,state,reason)
        VALUES($1,$2,'BLACKLISTED',$3)
        ON CONFLICT(inst_id) DO UPDATE SET base_ccy=EXCLUDED.base_ccy, state='BLACKLISTED', reason=EXCLUDED.reason, version=instrument_protection.version+1, updated_at=now()
        WHERE instrument_protection.state <> 'BLACKLISTED' OR instrument_protection.base_ccy <> EXCLUDED.base_ccy OR instrument_protection.reason <> EXCLUDED.reason
        RETURNING (xmax = 0) AS inserted`, [row.inst_id, row.base_ccy, row.reason]);
      if (!result.rowCount) report.unchanged += 1;
      else if (result.rows[0].inserted) report.inserted += 1;
      else report.conflict += 1;
      if (injectFailure) throw new Error("INJECTED_IMPORT_FAILURE");
    }
    await client.query("COMMIT");
    return report;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
