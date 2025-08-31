#!/usr/bin/env python3
"""
Database Configuration - PostgreSQL only
"""

import os
import psycopg2

def get_database_connection():
    """Get PostgreSQL database connection"""
    # Ensure environment variables are loaded
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    
    db_url = os.getenv('DATABASE_URL')
    
    if not db_url:
        raise ValueError("DATABASE_URL environment variable is required")
    
    if not db_url.startswith('postgresql://'):
        raise ValueError("DATABASE_URL must be a PostgreSQL connection string")
    
    try:
        return psycopg2.connect(db_url)
    except Exception as e:
        print(f"❌ PostgreSQL connection failed: {e}")
        raise

class Database:
    def __init__(self):
        """Initialize database connection"""
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Connect to PostgreSQL database"""
        try:
            self.conn = get_database_connection()
            self.cursor = self.conn.cursor()
            print("✅ Connected to PostgreSQL database")
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
            # PostgreSQL syntax
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS okx_announcements (
                    id SERIAL PRIMARY KEY,
                    ann_type VARCHAR(255) NOT NULL,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    p_time VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS trading_history (
                    id SERIAL PRIMARY KEY,
                    inst_id VARCHAR(255) NOT NULL,
                    side VARCHAR(50) NOT NULL,
                    amount TEXT NOT NULL,
                    price TEXT,
                    status VARCHAR(50) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            self.cursor.execute('''
                CREATE TABLE IF NOT EXISTS monitoring_logs (
                    id SERIAL PRIMARY KEY,
                    event_type VARCHAR(255) NOT NULL,
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
                VALUES (%s, %s, %s, %s)
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
                LIMIT %s
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
                VALUES (%s, %s)
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
