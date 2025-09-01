-- Create announcements tracking table for monitor_delist.py
-- This table stores processed announcements to avoid duplicate processing

CREATE TABLE IF NOT EXISTS processed_announcements (
    id SERIAL PRIMARY KEY,
    announcement_id VARCHAR(255) NOT NULL UNIQUE,  -- Unique ID: title_timestamp
    title TEXT NOT NULL,                           -- Announcement title
    url TEXT,                                      -- Announcement URL
    p_time BIGINT,                                 -- Publication timestamp
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- When it was processed
    announcement_type VARCHAR(50) DEFAULT 'delist', -- Type of announcement
    affected_cryptos TEXT[],                       -- Array of affected crypto symbols
    protection_executed BOOLEAN DEFAULT FALSE,     -- Whether protection was executed
    notes TEXT                                      -- Additional notes
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_processed_announcements_id ON processed_announcements(announcement_id);
CREATE INDEX IF NOT EXISTS idx_processed_announcements_processed_at ON processed_announcements(processed_at);
CREATE INDEX IF NOT EXISTS idx_processed_announcements_type ON processed_announcements(announcement_type);

-- Create a view for recent processed announcements
CREATE OR REPLACE VIEW recent_processed_announcements AS
SELECT announcement_id, title, processed_at, protection_executed, affected_cryptos
FROM processed_announcements
WHERE processed_at >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY processed_at DESC;

-- Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON processed_announcements TO your_user;
-- GRANT SELECT ON recent_processed_announcements TO your_user;
