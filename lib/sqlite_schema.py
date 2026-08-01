"""Canonical SQLite schema for the trading database."""

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY,
    crypto_symbol TEXT NOT NULL UNIQUE,
    reason TEXT,
    blacklist_type TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS crypto_limits (
    id INTEGER PRIMARY KEY,
    inst_id TEXT NOT NULL UNIQUE,
    best_limit TEXT NOT NULL,
    best_duration TEXT,
    max_returns TEXT,
    trade_count TEXT,
    trades_per_month TEXT,
    avg_return_per_trade TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    win_rate TEXT,
    median_earn TEXT
);

CREATE TABLE IF NOT EXISTS filled_orders (
    id INTEGER PRIMARY KEY,
    instid TEXT NOT NULL,
    ordid TEXT,
    tradeid TEXT NOT NULL UNIQUE,
    billid TEXT,
    fillpx TEXT NOT NULL,
    fillsz TEXT NOT NULL,
    side TEXT NOT NULL,
    ts TEXT NOT NULL,
    subtype TEXT,
    exectype TEXT,
    fee TEXT,
    feeccy TEXT,
    feerate TEXT,
    filltime TEXT,
    posside TEXT,
    clordid TEXT,
    tag TEXT,
    sell_time TEXT,
    sold_status TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    sell_order_id TEXT,
    trigger_rebuild_pending INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hour_limit (
    id INTEGER PRIMARY KEY,
    inst_id TEXT NOT NULL UNIQUE,
    limit_percent TEXT NOT NULL,
    limit_ratio TEXT NOT NULL,
    consistency TEXT,
    mean_return_timeslices TEXT,
    median_return_timeslices TEXT,
    recent_12m_return TEXT,
    sharpe_like TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS limits_config (
    id INTEGER PRIMARY KEY,
    generated_at TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    description TEXT,
    strategy_type TEXT,
    duration INTEGER,
    limit_range_min INTEGER,
    limit_range_max INTEGER,
    min_trades INTEGER,
    min_avg_earn TEXT,
    buy_fee TEXT,
    sell_fee TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitoring_logs (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS okx_announcements (
    id INTEGER PRIMARY KEY,
    ann_type TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    p_time TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    instid TEXT NOT NULL,
    flag TEXT NOT NULL,
    ordid TEXT NOT NULL,
    create_time INTEGER NOT NULL,
    ordertype TEXT,
    state TEXT,
    price TEXT,
    size TEXT,
    sell_time INTEGER,
    side TEXT,
    sell_price TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    sell_order_id TEXT
);

CREATE TABLE IF NOT EXISTS processed_announcements (
    id INTEGER PRIMARY KEY,
    announcement_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    url TEXT,
    p_time INTEGER,
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    announcement_type TEXT DEFAULT 'delist',
    affected_cryptos TEXT,
    protection_executed INTEGER DEFAULT 0,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS trading_history (
    id INTEGER PRIMARY KEY,
    inst_id TEXT NOT NULL,
    side TEXT NOT NULL,
    amount TEXT NOT NULL,
    price TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blacklist_active ON blacklist(is_active);
CREATE INDEX IF NOT EXISTS idx_blacklist_crypto_symbol ON blacklist(crypto_symbol);
CREATE INDEX IF NOT EXISTS idx_blacklist_type ON blacklist(blacklist_type);
CREATE INDEX IF NOT EXISTS idx_filled_orders_instid ON filled_orders(instid);
CREATE INDEX IF NOT EXISTS idx_filled_orders_ordid ON filled_orders(ordid);
CREATE INDEX IF NOT EXISTS idx_filled_orders_sell_time ON filled_orders(sell_time);
CREATE INDEX IF NOT EXISTS idx_filled_orders_side ON filled_orders(side);
CREATE INDEX IF NOT EXISTS idx_filled_orders_tradeid ON filled_orders(tradeid);
CREATE INDEX IF NOT EXISTS idx_filled_orders_ts ON filled_orders(ts);
CREATE INDEX IF NOT EXISTS idx_hour_limit_inst_id ON hour_limit(inst_id);
CREATE INDEX IF NOT EXISTS idx_orders_create_time ON orders(create_time);
CREATE INDEX IF NOT EXISTS idx_orders_flag ON orders(flag);
CREATE INDEX IF NOT EXISTS idx_orders_flag_create_time ON orders(flag, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_orders_flag_instid ON orders(flag, instid);
CREATE INDEX IF NOT EXISTS idx_orders_instid ON orders(instid);
CREATE INDEX IF NOT EXISTS idx_orders_instid_ordid_flag ON orders(instid, ordid, flag);
CREATE INDEX IF NOT EXISTS idx_orders_ordid ON orders(ordid);
CREATE INDEX IF NOT EXISTS idx_processed_announcements_id ON processed_announcements(announcement_id);
CREATE INDEX IF NOT EXISTS idx_processed_announcements_processed_at ON processed_announcements(processed_at);
CREATE INDEX IF NOT EXISTS idx_processed_announcements_type ON processed_announcements(announcement_type);
"""


def create_sqlite_schema(connection) -> None:
    connection.executescript(SCHEMA_SQL)
    connection.execute("PRAGMA user_version = 1")
    connection.commit()
