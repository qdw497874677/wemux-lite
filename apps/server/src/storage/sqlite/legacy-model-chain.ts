// Repair migration36 as well as pre-upgrade databases. A cancelled command can
// still receive a Worker receipt; a rejected predecessor's speculative target
// may also be captured by a later command. Therefore the fallback is the start
// of the ENTIRE retained legacy chain, not the first still-pending command.
// Latest contiguous Worker history always wins. Never rewrite command identity.
export const legacyModelChainMigration = `
WITH legacy AS (
 SELECT rowid AS position, status, json_extract(data,'$.command.sessionId') AS session_id,
        json_extract(data,'$.command.arguments.previousModelId') AS previous_model
 FROM commands
 WHERE json_extract(data,'$.command.kind')='runtime.command'
   AND json_extract(data,'$.command.name')='set_model'
   AND json_type(data,'$.command.arguments.previousModelId') IN ('text','null')
), targets AS (
 SELECT session_id, previous_model FROM legacy first
 WHERE position=(SELECT MIN(position) FROM legacy WHERE session_id=first.session_id)
   AND EXISTS(SELECT 1 FROM legacy unsettled WHERE unsettled.session_id=first.session_id AND unsettled.status IN ('pending','cancelled'))
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
