//! Session metadata in SQLite. Output history lives in plain files next to it
//! (`history/<id>.log`): it is large, append-only and never queried.

use std::path::Path;

use aurora_core::session::{SessionInfo, agents::Hooks};
use rusqlite::{Connection, params};

pub struct Db(Connection);

#[derive(Debug, Clone)]
pub struct Row {
    pub info: SessionInfo,
    pub hooks: Hooks,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS sessions (
                 id TEXT PRIMARY KEY,
                 created_ms INTEGER NOT NULL,
                 hooks TEXT NOT NULL,
                 info TEXT NOT NULL
             );",
        )?;
        Ok(Db(conn))
    }

    pub fn load(&self) -> rusqlite::Result<Vec<Row>> {
        let mut st = self.0.prepare("SELECT info, hooks FROM sessions ORDER BY created_ms")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (info, hooks) = row?;
            // A row from an incompatible build is skipped, not fatal.
            if let (Ok(info), Ok(hooks)) =
                (serde_json::from_str(&info), serde_json::from_value(serde_json::Value::String(hooks)))
            {
                out.push(Row { info, hooks });
            }
        }
        Ok(out)
    }

    pub fn save(&self, info: &SessionInfo, hooks: Hooks) -> rusqlite::Result<()> {
        let hooks = serde_json::to_value(hooks).expect("enum serializes");
        self.0.execute(
            "INSERT INTO sessions (id, created_ms, hooks, info) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET info = excluded.info, hooks = excluded.hooks",
            params![
                info.id,
                info.created_ms as i64,
                hooks.as_str().unwrap_or("none"),
                serde_json::to_string(info).unwrap()
            ],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<()> {
        self.0.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::session::Status;

    fn info(id: &str) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            name: "n".into(),
            agent: "claude".into(),
            cwd: "/tmp".into(),
            workspace: "/tmp".into(),
            branch: Some("main".into()),
            worktree: None,
            status: Status::Running,
            alive: true,
            exit_code: None,
            created_ms: 1,
            updated_ms: 1,
            title: None,
            renamed: false,
            stage: Default::default(),
        }
    }

    #[test]
    fn save_load_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("s.db")).unwrap();
        db.save(&info("a"), Hooks::Claude).unwrap();
        let mut b = info("b");
        db.save(&b, Hooks::None).unwrap();
        b.name = "renamed".into();
        db.save(&b, Hooks::None).unwrap();

        let db = Db::open(&dir.path().join("s.db")).unwrap();
        let rows = db.load().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].hooks, Hooks::Claude);
        assert_eq!(rows[1].info.name, "renamed");
        db.delete("a").unwrap();
        assert_eq!(db.load().unwrap().len(), 1);
    }
}
