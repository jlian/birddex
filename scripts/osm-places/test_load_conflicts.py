"""Prove flush() distinguishes an identical overlap from a conflicting one."""
import importlib.util
import sqlite3
import sys

spec = importlib.util.spec_from_file_location("b", "scripts/osm-places/build-search-db.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

db = sqlite3.connect(":memory:")
db.executescript(m.DDL.split("-- One row per alias")[0])

row = ("way1", "Foo", 1.0, 2.0, 25, "park", None, None, "foo", None, None, None)
dup_same = ("way1", "Foo", 1.0, 2.0, 25, "park", None, None, "foo", None, None, None)
dup_diff = ("way1", "Bar", 9.9, 8.8, 25, "park", None, None, "bar", None, None, None)

failures = 0

c = m.flush(db, [row])
print("fresh insert            conflicts=", c, "(want 0)")
failures += c != 0

c = m.flush(db, [dup_same])
print("identical border repeat conflicts=", c, "(want 0)")
failures += c != 0

c = m.flush(db, [dup_diff])
print("SAME id, DIFFERENT data conflicts=", c, "(want 1)")
failures += c != 1

n = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
print("rows stored             ", n, "(want 1)")
failures += n != 1

print("ALL PASS" if failures == 0 else f"{failures} FAILURE(S)")
sys.exit(1 if failures else 0)
