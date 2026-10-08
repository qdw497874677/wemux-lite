// Keep seek, ordering and the expression index identical, including legacy missing timestamps.
export function attentionRunOrderTimestamp(dataColumn: 'data' | 'r.data'): string {
  return `CAST(COALESCE(json_extract(${dataColumn},'$.finishedAt'),json_extract(${dataColumn},'$.createdAt'),'') AS TEXT)`
}

// These indexes assist ordering, not a strict bound on rows visited: Run creator filtering
// still joins commands and Project authorization may exclude any number of candidates.
export const attentionPageIndexesMigration = `
  CREATE INDEX attention_failed_runs_order ON task_runs(${attentionRunOrderTimestamp('data')} DESC,id ASC) WHERE status='failed';
  CREATE INDEX attention_dead_letters_order ON channel_outbound_deliveries(updated_at DESC,id ASC,project_id) WHERE status='dead_letter';
`

export function attentionReviewOrderTimestamp(dataColumn: 'data' | 'v.data'): string {
  return `CAST(COALESCE(json_extract(${dataColumn},'$.requestedAt'),'') AS TEXT)`
}

// Separate migration so existing databases receive the new source's ordering index.
export const attentionHumanReviewIndexMigration = `
  CREATE INDEX attention_human_reviews_order ON review_requests(${attentionReviewOrderTimestamp('data')} DESC,id ASC,project_id)
    WHERE status='requested' AND json_extract(data,'$.closedAt') IS NULL;
`
