#!/usr/bin/env python3
"""
SQLite Database Configuration
Simple local database setup for the crypto trading application
"""

import sqlite3
import os
from pathlib import Path

class Database:
    def __init__(self, db_path="database.db"):
        """Initialize database connection"""
        self.db_path = db_path
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Connect to SQLite database"""
        try:
            self.conn = sqlite3.connect(self.db_path)
            self.cursor = self.conn.cursor()
            print(f"✅ Connected to SQLite database: {self.db_path}")
            return True
        except Exception as e:
            print(f"❌ Database connection failed: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from database"""
        if self.conn:
            self.conn.close()
            print("✅ Database connection closed")
    
    def create_tables(self):
        """Create necessary database tables"""
        try:
            # Table for storing OKX announcements
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS okx_announcements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ann_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    p_time TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            # Table for storing trading history
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS trading_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    inst_id TEXT NOT NULL,
                    side TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    price TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            # Table for storing monitoring logs
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS monitoring_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            self.conn.commit()
            print("✅ Database tables created successfully")
            return True
            
        except Exception as e:
            print(f"❌ Failed to create tables: {e}")
            return False
    
    def insert_announcement(self, ann_type, title, url, p_time):
        """Insert new announcement into database"""
        try:
            self.cursor.execute('''
                INSERT INTO okx_announcements (ann_type, title, url, p_time)
                VALUES (?, ?, ?, ?)
            ''', (ann_type, title, url, p_time))
            self.conn.commit()
            return True
        except Exception as e:
            print(f"❌ Failed to insert announcement: {e}")
            return False
    
    def get_announcements(self, limit=100):
        """Get recent announcements from database"""
        try:
            self.cursor.execute('''
                SELECT * FROM okx_announcements 
                ORDER BY created_at DESC 
                LIMIT ?
            ''', (limit,))
            return self.cursor.fetchall()
        except Exception as e:
            print(f"❌ Failed to get announcements: {e}")
            return []
    
    def log_monitoring_event(self, event_type, message):
        """Log monitoring events"""
        try:
            self.cursor.execute('''
                INSERT INTO monitoring_logs (event_type, message)
                VALUES (?, ?)
            ''', (event_type, message))
            self.conn.commit()
            return True
        except Exception as e:
            print(f"❌ Failed to log event: {e}")
            return False

def init_database():
    """Initialize database and create tables"""
    db = Database()
    if db.connect():
        db.create_tables()
        db.disconnect()
        return True
    return False

if __name__ == "__main__":
    # Test database initialization
    print("🧪 Testing database initialization...")
    if init_database():
        print("✅ Database initialized successfully")
    else:
        print("❌ Database initialization failed")
