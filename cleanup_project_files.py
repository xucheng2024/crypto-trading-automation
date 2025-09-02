#!/usr/bin/env python3
"""
Project cleanup script to remove unnecessary files
"""

import os
import shutil
from datetime import datetime

def cleanup_project_files():
    """Remove unnecessary project files"""
    print("🧹 Starting project cleanup...")
    
    # Files to remove (one-time tools and completed tasks)
    files_to_remove = [
        'migrate_limits_to_db.py',           # Migration completed
        'test_database_limits.py',           # Tests completed
        'cleanup_database_tables.py',        # Cleanup completed
        'create_announcements_table.sql',    # Tables created
        'create_blacklist_table.sql',        # Tables created
        'DATABASE_LIMITS_README.md',         # Migration documentation
    ]
    
    # Directories to clean
    directories_to_clean = [
        'logs',  # Clean old log files
    ]
    
    removed_files = []
    failed_removals = []
    
    # Remove files
    for file_path in files_to_remove:
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
                removed_files.append(file_path)
                print(f"✅ Removed: {file_path}")
            else:
                print(f"⚠️  File not found: {file_path}")
        except Exception as e:
            failed_removals.append((file_path, str(e)))
            print(f"❌ Failed to remove {file_path}: {e}")
    
    # Clean log directories
    for dir_path in directories_to_clean:
        try:
            if os.path.exists(dir_path):
                # Keep recent logs (last 7 days)
                current_time = datetime.now().timestamp()
                seven_days_ago = current_time - (7 * 24 * 60 * 60)
                
                log_files = []
                for file in os.listdir(dir_path):
                    file_path = os.path.join(dir_path, file)
                    if os.path.isfile(file_path):
                        file_time = os.path.getmtime(file_path)
                        if file_time < seven_days_ago:
                            log_files.append(file_path)
                
                for log_file in log_files:
                    try:
                        os.remove(log_file)
                        print(f"✅ Removed old log: {log_file}")
                    except Exception as e:
                        print(f"❌ Failed to remove log {log_file}: {e}")
                
                # Count remaining files
                remaining_files = len([f for f in os.listdir(dir_path) if os.path.isfile(os.path.join(dir_path, f))])
                print(f"📊 {dir_path}: {remaining_files} recent log files kept")
            else:
                print(f"⚠️  Directory not found: {dir_path}")
        except Exception as e:
            print(f"❌ Failed to clean directory {dir_path}: {e}")
    
    # Summary
    print("\n" + "=" * 60)
    print("📊 Cleanup Summary:")
    print(f"✅ Files removed: {len(removed_files)}")
    for file in removed_files:
        print(f"  - {file}")
    
    if failed_removals:
        print(f"❌ Failed removals: {len(failed_removals)}")
        for file, error in failed_removals:
            print(f"  - {file}: {error}")
    
    return len(removed_files) > 0

def main():
    """Main function"""
    print("=" * 60)
    print("🧹 Project Cleanup Tool")
    print("=" * 60)
    
    if cleanup_project_files():
        print("\n🎉 Project cleanup completed!")
        print("💡 Consider running 'git add .' and 'git commit' to save changes")
    else:
        print("\n⚠️  No files were removed")

if __name__ == "__main__":
    main()
