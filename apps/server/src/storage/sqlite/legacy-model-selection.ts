// Legacy set_model admission optimistically changed the Session before the
// Worker confirmed it. Reconcile once at upgrade, never on a delayed receipt:
// a later ordered model event must win even when it selects the same value.
// Command rows and fingerprints are deliberately untouched for wire replay.
export const legacyModelSelectionMigration = `
WITH pending AS (
 SELECT rowid AS position, json_extract(data,'$.command.sessionId') AS session_id,
        json_extract(data,'$.command.arguments.previousModelId') AS previous_model
 FROM commands
 WHERE status='pending' AND json_extract(data,'$.command.kind')='runtime.command'
   AND json_extract(data,'$.command.name')='set_model'
   AND json_type(data,'$.command.arguments.previousModelId') IN ('text','null')
), targets AS (
 SELECT session_id, previous_model FROM pending p
 WHERE position=(SELECT MIN(position) FROM pending WHERE session_id=p.session_id)
), confirmed AS (
 SELECT e.session_id, e.seq, json_extract(e.data,'$.payload.modelId') AS model_id
 FROM events e JOIN records cache ON cache.kind='cache' AND cache.id=e.session_id
 WHERE e.seq<=json_extract(cache.data,'$.contiguousSeq')
   AND json_extract(e.data,'$.payload.kind')='model.changed'
   AND json_type(e.data,'$.payload.modelId') IN ('text','null')
)
UPDATE records AS s SET data=json_set(s.data,'$.binding.modelId',
 CASE WHEN EXISTS(SELECT 1 FROM confirmed WHERE session_id=s.id)
 THEN (SELECT model_id FROM confirmed WHERE session_id=s.id ORDER BY seq DESC LIMIT 1)
 ELSE (SELECT previous_model FROM targets WHERE session_id=s.id) END)
WHERE s.kind='session' AND s.id IN (SELECT session_id FROM targets);
`
