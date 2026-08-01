#!/usr/bin/env python3
"""
SQLite database configuration.
"""

from datetime import datetime
from lib.db_backend import get_database_backend, get_database_connection
from lib.sqlite_schema import create_sqlite_schema

class Database:
    def __init__(self):
        """Initialize database connection"""
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Connect to the configured database."""
        try:
            self.conn = get_database_connection()
            self.cursor = self.conn.cursor()
            print(f"✅ Connected to {get_database_backend(self.conn)} database")
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
            create_sqlite_schema(self.conn)
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
    
    def save_limits_config(self, config_data):
        """Save limits configuration to database"""
        try:
            # Clear existing config first
            self.cursor.execute('DELETE FROM limits_config')
            self.cursor.execute('DELETE FROM crypto_limits')
            
            # Insert main config
            strategy_params = config_data.get('strategy_params', {})
            limit_range = strategy_params.get('limit_range', [])

            generated_at = config_data.get('generated_at')
            if isinstance(generated_at, str):
                try:
                    generated_at = datetime.fromisoformat(generated_at)
                except ValueError:
                    # Preserve an unexpected string for SQLite to store as text.
                    pass
            
            self.cursor.execute('''
                INSERT INTO limits_config 
                (generated_at, strategy_name, description, strategy_type, duration,
                 limit_range_min, limit_range_max, min_trades, min_avg_earn, buy_fee, sell_fee)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ''', (
                generated_at,
                config_data.get('strategy_name'),
                config_data.get('description'),
                config_data.get('strategy_type'),
                config_data.get('duration'),
                limit_range[0] if len(limit_range) > 0 else None,
                limit_range[1] if len(limit_range) > 1 else None,
                strategy_params.get('min_trades'),
                strategy_params.get('min_avg_earn'),
                strategy_params.get('buy_fee'),
                strategy_params.get('sell_fee')
            ))
            
            # Insert crypto configs
            crypto_configs = config_data.get('crypto_configs', {})
            for inst_id, config in crypto_configs.items():
                self.cursor.execute('''
                    INSERT INTO crypto_limits 
                    (inst_id, best_limit, best_duration, max_returns, trade_count, trades_per_month, win_rate, median_earn, avg_return_per_trade)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ''', (
                    inst_id,
                    config.get('best_limit'),
                    config.get('best_duration'),
                    config.get('max_returns'),
                    config.get('trade_count'),
                    config.get('trades_per_month'),
                    config.get('win_rate'),
                    config.get('median_earn'),
                    config.get('avg_return_per_trade')
                ))
            
            self.conn.commit()
            print(f"✅ Saved limits configuration with {len(crypto_configs)} crypto pairs")
            return True
        except Exception as e:
            try:
                if self.conn:
                    self.conn.rollback()
            except Exception:
                pass
            print(f"❌ Failed to save limits config: {e}")
            return False
    
    def load_limits_config(self):
        """Load limits configuration from database"""
        try:
            # Load main config
            self.cursor.execute('SELECT * FROM limits_config ORDER BY created_at DESC LIMIT 1')
            config_row = self.cursor.fetchone()
            
            if not config_row:
                print("❌ No limits configuration found in database")
                return None
            
            # Load crypto configs with explicit column names
            self.cursor.execute('''
                SELECT inst_id, best_limit, best_duration, max_returns, trade_count, 
                       trades_per_month, win_rate, median_earn, avg_return_per_trade
                FROM crypto_limits ORDER BY inst_id
            ''')
            crypto_rows = self.cursor.fetchall()
            
            # Build config structure
            config_data = {
                'generated_at': (
                    config_row[1].isoformat()
                    if config_row[1] and hasattr(config_row[1], 'isoformat')
                    else config_row[1]
                ),
                'strategy_name': config_row[2],
                'description': config_row[3],
                'strategy_type': config_row[4],
                'duration': config_row[5],
                'strategy_params': {
                    'limit_range': [config_row[6], config_row[7]] if config_row[6] and config_row[7] else [],
                    'min_trades': config_row[8],
                    'min_avg_earn': float(config_row[9]) if config_row[9] else None,
                    'buy_fee': float(config_row[10]) if config_row[10] else None,
                    'sell_fee': float(config_row[11]) if config_row[11] else None
                },
                'crypto_configs': {}
            }
            
            # Add crypto configs (row: inst_id, best_limit, best_duration, max_returns, trade_count, trades_per_month, win_rate, median_earn, avg_return_per_trade)
            for row in crypto_rows:
                inst_id = row[0]
                config_data['crypto_configs'][inst_id] = {
                    'best_limit': row[1],
                    'best_duration': row[2],
                    'max_returns': row[3],
                    'trade_count': row[4],
                    'trades_per_month': row[5],
                    'win_rate': row[6],
                    'median_earn': row[7],
                    'avg_return_per_trade': row[8]
                }
            
            print(f"✅ Loaded limits configuration with {len(crypto_rows)} crypto pairs")
            return config_data
        except Exception as e:
            print(f"❌ Failed to load limits config: {e}")
            return None
    
    def get_configured_cryptos(self):
        """Get list of configured cryptocurrency symbols"""
        try:
            self.cursor.execute('SELECT inst_id FROM crypto_limits ORDER BY inst_id')
            rows = self.cursor.fetchall()
            return [row[0] for row in rows]
        except Exception as e:
            print(f"❌ Failed to get configured cryptos: {e}")
            return []
    
    def get_crypto_config(self, inst_id):
        """Get configuration for specific crypto pair"""
        try:
            self.cursor.execute('''
                SELECT inst_id, best_limit, best_duration, max_returns, trade_count, 
                       trades_per_month, win_rate, median_earn, avg_return_per_trade
                FROM crypto_limits WHERE inst_id = %s
            ''', (inst_id,))
            row = self.cursor.fetchone()
            
            if not row:
                return None
            
            return {
                'best_limit': row[1],
                'best_duration': row[2],
                'max_returns': row[3],
                'trade_count': row[4],
                'trades_per_month': row[5],
                'win_rate': row[6],
                'median_earn': row[7],
                'avg_return_per_trade': row[8]
            }
        except Exception as e:
            print(f"❌ Failed to get crypto config for {inst_id}: {e}")
            return None
    
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
