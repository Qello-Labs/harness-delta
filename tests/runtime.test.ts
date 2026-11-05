import Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { expect, test } from "vitest";

test("SQLite native binding supports transactions and rollback", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO probe (id, value) VALUES (?, ?)");
    db.transaction(() => insert.run(1, "synthetic"))();
    expect(() =>
      db.transaction(() => {
        insert.run(2, "rollback");
        insert.run(1, "duplicate");
      })()
    ).toThrow();
    expect(db.prepare("SELECT * FROM probe ORDER BY id").all()).toEqual([{ id: 1, value: "synthetic" }]);
  } finally {
    db.close();
  }
});

test("decimal amounts serialize without binary floating point rounding", () => {
  expect(new Decimal("0.1").plus("0.2").toString()).toBe("0.3");
});
