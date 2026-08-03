#!/usr/bin/env python3
"""Export the mutable trading tables from the VPS SQLite database for D1.

Run only after the legacy scheduler is stopped and while holding its flock.
The generated SQL contains trading history and must not be committed.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


TABLES = ("blacklist", "crypto_limits", "filled_orders", "processed_announcements")


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return f"X'{value.hex()}'"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_table(connection, table, output):
    columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
    if not columns:
        raise RuntimeError(f"Missing required table: {table}")
    rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
    output.write(f'DELETE FROM "{table}";\n')
    quoted_columns = ",".join(f'"{column}"' for column in columns)
    for start in range(0, len(rows), 50):
        values = ",\n".join(
            "(" + ",".join(sql_literal(value) for value in row) + ")"
            for row in rows[start : start + 50]
        )
        output.write(f'INSERT INTO "{table}" ({quoted_columns}) VALUES\n{values};\n')
    return len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not args.database.is_file():
        raise FileNotFoundError(args.database)
    connection = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    try:
        with args.output.open("w", encoding="utf-8") as output:
            total = 0
            for table in TABLES:
                count = export_table(connection, table, output)
                print(f"{table}: {count} row(s)")
                total += count
        args.output.chmod(0o600)
        print(f"Exported {total} row(s) to {args.output}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
