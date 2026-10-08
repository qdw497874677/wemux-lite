/** Never expire these fences: an earlier HTTP request may arrive after release.
 * They reserve the global command identity without creating dispatchable work. */
export const commandRejectionsMigration = `
CREATE TABLE command_rejections (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.commandId') IS id)
);
CREATE TRIGGER command_rejection_no_existing BEFORE INSERT ON command_rejections BEGIN
  SELECT RAISE(ABORT,'Conflicting commandId') WHERE EXISTS(SELECT 1 FROM commands WHERE id=NEW.id);
END;
CREATE TRIGGER command_rejection_no_dispatch BEFORE INSERT ON commands BEGIN
  SELECT RAISE(ABORT,'Conflicting commandId') WHERE EXISTS(SELECT 1 FROM command_rejections WHERE id=NEW.id);
END;
CREATE TRIGGER command_rejection_no_update BEFORE UPDATE ON command_rejections BEGIN
  SELECT RAISE(ABORT,'Command rejection is immutable');
END;
CREATE TRIGGER command_rejection_no_delete BEFORE DELETE ON command_rejections BEGIN
  SELECT RAISE(ABORT,'Command rejection is immutable');
END;
`
