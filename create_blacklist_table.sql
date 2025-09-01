-- Create blacklist table for cryptocurrency monitoring
-- This table stores cryptocurrencies that should be excluded from trading or monitoring

CREATE TABLE IF NOT EXISTS blacklist (
    id SERIAL PRIMARY KEY,
    crypto_symbol VARCHAR(20) NOT NULL UNIQUE,  -- e.g., 'BTC', 'ETH', 'WBTC'
    reason TEXT,                                -- Reason for blacklisting
    blacklist_type VARCHAR(50) DEFAULT 'manual', -- 'manual', 'delisted', 'suspicious', etc.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,             -- Whether the blacklist entry is active
    notes TEXT                                   -- Additional notes or comments
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_blacklist_crypto_symbol ON blacklist(crypto_symbol);
CREATE INDEX IF NOT EXISTS idx_blacklist_active ON blacklist(is_active);
CREATE INDEX IF NOT EXISTS idx_blacklist_type ON blacklist(blacklist_type);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_blacklist_updated_at 
    BEFORE UPDATE ON blacklist 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Insert some example data (optional)
INSERT INTO blacklist (crypto_symbol, reason, blacklist_type, notes) VALUES
    ('WBTC', 'Wrapped Bitcoin - potential delisting risk', 'manual', 'Monitor for delisting announcements'),
    ('JST', 'Just Token - delisted from OKX', 'delisted', 'Already delisted, no longer trading'),
    ('BTT', 'BitTorrent Token - delisted from OKX', 'delisted', 'Already delisted, no longer trading'),
    ('ERN', 'Ethernity Chain - delisted from OKX', 'delisted', 'Already delisted, no longer trading'),
    ('GLMR', 'Moonbeam - delisted from OKX', 'delisted', 'Already delisted, no longer trading'),
    ('MOVR', 'Moonriver - delisted from OKX', 'delisted', 'Already delisted, no longer trading')
ON CONFLICT (crypto_symbol) DO NOTHING;

-- Create a view for active blacklist entries
CREATE OR REPLACE VIEW active_blacklist AS
SELECT crypto_symbol, reason, blacklist_type, created_at, notes
FROM blacklist
WHERE is_active = TRUE
ORDER BY created_at DESC;

-- Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON blacklist TO your_user;
-- GRANT SELECT ON active_blacklist TO your_user;
