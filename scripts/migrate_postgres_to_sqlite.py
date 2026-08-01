#!/usr/bin/env python3
"""Create a validated SQLite snapshot from the current PostgreSQL database."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg2
from psycopg2 import sql
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lib.sqlite_schema import create_sqlite_schema


TABLES = (
    "blacklist",
    "crypto_limits",
    "filled_orders",
    "hour_limit",
    "limits_config",
    "monitoring_logs",
    "okx_announcements",
    "orders",
    "processed_announcements",
    "trading_history",
)


def sqlite_value(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (list, tuple, dict)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, memoryview):
        return bytes(value)
    return value


def row_digest(rows) -> str:
    digest = hashlib.sha256()
    for row in rows:
        payload = json.dumps(list(row), ensure_ascii=False, separators=(",", ":"), default=str)
        digest.update(payload.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def migrate(source_url: str, target: Path, overwrite: bool = False) -> dict[str, int]:
    if not source_url.startswith("postgresql://"):
        raise ValueError("Source URL must use postgresql://")
    target = target.expanduser().resolve()
    if target.exists() and not overwrite:
        raise FileExistsError(f"Target already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_target = target.with_name(f".{target.name}.tmp-{os.getpid()}")
    if temp_target.exists():
        temp_target.unlink()

    source = psycopg2.connect(source_url)
    destination = None
    try:
        source.set_session(isolation_level="REPEATABLE READ", readonly=True, autocommit=False)
        destination = sqlite3.connect(temp_target)
        destination.execute("PRAGMA journal_mode = DELETE")
        destination.execute("PRAGMA synchronous = FULL")
        create_sqlite_schema(destination)

        counts = {}
        with source.cursor() as source_cursor:
            for table in TABLES:
                source_cursor.execute(
                    sql.SQL("SELECT * FROM {} ORDER BY id").format(sql.Identifier(table))
                )
                source_rows = [tuple(sqlite_value(value) for value in row) for row in source_cursor.fetchall()]
                columns = [description.name for description in source_cursor.description]
                placeholders = ",".join("?" for _ in columns)
                quoted_columns = ",".join(f'"{column}"' for column in columns)
                if source_rows:
                    destination.executemany(
                        f'INSERT INTO "{table}" ({quoted_columns}) VALUES ({placeholders})',
                        source_rows,
                    )
                destination.commit()

                sqlite_rows = destination.execute(f'SELECT * FROM "{table}" ORDER BY id').fetchall()
                if len(sqlite_rows) != len(source_rows):
                    raise RuntimeError(f"Row count mismatch for {table}")
                if row_digest(sqlite_rows) != row_digest(source_rows):
                    raise RuntimeError(f"Row digest mismatch for {table}")
                counts[table] = len(source_rows)

        integrity = destination.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        destination.close()
        destination = None
        os.chmod(temp_target, 0o600)
        os.replace(temp_target, target)
        return counts
    finally:
        source.rollback()
        source.close()
        if destination is not None:
            destination.close()
        if temp_target.exists():
            temp_target.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-env", default="DATABASE_URL")
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    load_dotenv()
    source_url = os.getenv(args.source_env)
    if not source_url:
        raise ValueError(f"{args.source_env} is not configured")
    counts = migrate(source_url, args.target, overwrite=args.overwrite)
    print(f"Migrated {sum(counts.values())} rows across {len(counts)} tables")
    for table, count in counts.items():
        print(f"  {table}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
