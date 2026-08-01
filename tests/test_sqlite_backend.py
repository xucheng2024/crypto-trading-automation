import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from blacklist_manager import BlacklistManager
from lib.db_backend import get_database_connection, get_database_cursor
from lib.sqlite_schema import create_sqlite_schema


class SQLiteBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "trading.sqlite3"
        connection = sqlite3.connect(self.database_path)
        create_sqlite_schema(connection)
        connection.close()
        self.database_url = f"sqlite:///{self.database_path}"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_native_sqlite_placeholders_and_regex(self):
        with get_database_connection(self.database_url) as connection:
            cursor = connection.cursor()
            cursor.execute(
                "INSERT INTO filled_orders "
                "(instid, tradeid, fillpx, fillsz, side, ts) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("BTC-USDT", "trade-1", "1", "2", "buy", "123"),
            )
            cursor.execute(
                "SELECT tradeid FROM filled_orders WHERE ts REGEXP '^[0-9]+$' AND tradeid = ?",
                ("trade-1",),
            )
            self.assertEqual(cursor.fetchone()[0], "trade-1")

    def test_blacklist_manager_reads_and_writes_sqlite(self):
        with patch.dict(os.environ, {"DATABASE_URL": self.database_url}):
            manager = BlacklistManager()
            self.assertTrue(manager.add_to_blacklist("BTC", "test"))
            self.assertEqual(manager.get_blacklisted_cryptos(), {"BTC"})
            self.assertEqual(manager.get_blacklist_reason("BTC"), "delisted: test")
            self.assertTrue(
                manager.mark_announcement_processed(
                    "announcement-1",
                    "Title",
                    "https://example.test",
                    123,
                    {"BTC", "ETH"},
                    True,
                )
            )

        with get_database_connection(self.database_url) as connection:
            with get_database_cursor(connection, dict_rows=True) as cursor:
                cursor.execute(
                    "SELECT affected_cryptos, protection_executed "
                    "FROM processed_announcements WHERE announcement_id = ?",
                    ("announcement-1",),
                )
                row = cursor.fetchone()
                self.assertEqual(json.loads(row["affected_cryptos"]), ["BTC", "ETH"])
                self.assertEqual(row["protection_executed"], 1)

    def test_missing_sqlite_database_fails_closed(self):
        missing_url = f"sqlite:///{Path(self.temp_dir.name) / 'missing.sqlite3'}"
        with self.assertRaises(FileNotFoundError):
            get_database_connection(missing_url)


if __name__ == "__main__":
    unittest.main()
