"""SQLite database helpers for the trading runtime."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Optional

SQLITE_URL_PREFIX = "sqlite:///"


def get_database_url(database_url: Optional[str] = None) -> str:
    url = database_url or os.getenv("DATABASE_URL")
    if not url:
        try:
            from dotenv import load_dotenv

            load_dotenv()
            if not os.getenv("DATABASE_URL"):
                load_dotenv(dotenv_path=".env.local")
            url = os.getenv("DATABASE_URL")
        except ImportError:
            pass
    if not url:
        raise ValueError("DATABASE_URL environment variable is required")
    if not url.startswith(SQLITE_URL_PREFIX):
        raise ValueError("DATABASE_URL must use sqlite:///")
    return url


def get_sqlite_path(database_url: str) -> Path:
    if not database_url.startswith(SQLITE_URL_PREFIX):
        raise ValueError("Not a SQLite DATABASE_URL")
    raw_path = database_url[len(SQLITE_URL_PREFIX):]
    if not raw_path or raw_path == ":memory:":
        raise ValueError("SQLite DATABASE_URL must point to a persistent file")
    return Path(raw_path).expanduser().resolve()


def _adapt_sqlite_value(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, (list, tuple, dict, set)):
        serializable = sorted(value) if isinstance(value, set) else value
        return json.dumps(serializable, ensure_ascii=False, separators=(",", ":"))
    return value


def _adapt_sqlite_params(params: Optional[Iterable[Any]]) -> Optional[tuple[Any, ...]]:
    if params is None:
        return None
    return tuple(_adapt_sqlite_value(value) for value in params)


class SQLiteCursor:
    def __init__(self, cursor: sqlite3.Cursor):
        self._cursor = cursor

    def execute(self, statement: str, params: Optional[Iterable[Any]] = None):
        adapted = _adapt_sqlite_params(params)
        if adapted is None:
            self._cursor.execute(statement)
        else:
            self._cursor.execute(statement, adapted)
        return self

    def executemany(self, statement: str, rows: Iterable[Iterable[Any]]):
        self._cursor.executemany(statement, (_adapt_sqlite_params(row) for row in rows))
        return self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False

    def __iter__(self):
        return iter(self._cursor)

    def __getattr__(self, name: str):
        return getattr(self._cursor, name)


class SQLiteConnection:
    backend = "sqlite"

    def __init__(self, connection: sqlite3.Connection, path: Path):
        self._connection = connection
        self.path = path

    def cursor(self, *args, **kwargs) -> SQLiteCursor:
        return SQLiteCursor(self._connection.cursor())

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return self._connection.__exit__(exc_type, exc_value, traceback)

    def __getattr__(self, name: str):
        return getattr(self._connection, name)


def _open_sqlite(path: Path, require_existing: bool) -> SQLiteConnection:
    if require_existing and not path.is_file():
        raise FileNotFoundError(f"SQLite database does not exist: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.create_function(
        "regexp",
        2,
        lambda pattern, value: int(value is not None and re.search(pattern, str(value)) is not None),
    )
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA foreign_keys = ON")
    return SQLiteConnection(connection, path)


def get_database_connection(
    database_url: Optional[str] = None,
    *,
    require_existing: Optional[bool] = None,
):
    url = get_database_url(database_url)
    if require_existing is None:
        require_existing = os.getenv("DATABASE_ALLOW_CREATE", "false").lower() != "true"
    return _open_sqlite(get_sqlite_path(url), require_existing=require_existing)


def get_database_cursor(connection, *, dict_rows: bool = False):
    return connection.cursor()


def get_database_backend(connection=None, database_url: Optional[str] = None) -> str:
    return "SQLite"
