# OKX Delist Spot Monitoring Script

## 🎯 Feature Description

This monitoring script automatically checks **every 5 minutes** for **today's delist spot announcements** from OKX, and immediately issues alerts if new announcements are found.

## 🚀 Quick Start

### Method 1: Use startup script (recommended)
```bash
./start_monitor.sh
```

### Method 2: Run Python script directly
```bash
python3 monitor_delist.py
```

## ⚙️ Configuration Requirements

### 1. Environment Variables
Ensure your `.env.local` file contains the following OKX API keys:
```env
OKX_API_KEY=your_api_key_here
OKX_SECRET_KEY=your_secret_key_here
OKX_PASSPHRASE=your_passphrase_here
```

### 2. Python Dependencies
```bash
pip install requests python-dotenv
```

## 🔍 Monitoring Features

- **⏰ Check Frequency**: Every 5 minutes
- **🎯 Monitoring Content**: Only focus on delist spot related announcements
- **📅 Time Range**: Only check today's announcements
- **🚨 Alert Methods**: 
  - Console display with detailed information
  - Play system sound (macOS)
  - Extensible for other alert methods

## 📱 Alert Example

When a new announcement is found, the following alert will be displayed:

```
================================================================================
🚨 Alert! Today's Delist Spot announcement found!
================================================================================
📅 Announcement Date: 2025-06-30 16:00:00
📢 Announcement Title: OKX to delist X, BSV, GOG, DIA, BONE and OXT spot trading pairs
🔗 Detailed Link: https://www.okx.com/help/okx-to-delist-x-bsv-gog-dia-bone-and-oxt-spot-trading-pairs
⏰ Timestamp: 1751270400000
================================================================================
🔊 System sound played
```

## 🛠️ Custom Configuration

### Modify Check Interval
In `monitor_delist.py`, modify:
```python
self.check_interval = 300  # 5 minutes = 300 seconds
```

### Add More Alert Methods
In the `send_alert` method, add:
```python
# Send email
# Send DingTalk/WeChat Work messages
# Send push notifications
# And more...
```

## 🚫 Stop Monitoring

Press `Ctrl+C` to stop the monitoring service.

## 📊 Running Status

When monitoring is running, it will display:
```
🚀 OKX Delist Spot monitoring started
⏰ Check interval: 300 seconds (5.0 minutes)
🔑 API Key: ✅ Configured
🔑 Secret Key: ✅ Configured
🔑 Passphrase: ✅ Configured

Starting monitoring... (Press Ctrl+C to stop)

🔍 [2025-08-26 20:30:00] Starting delist announcement check...
✅ No new today's spot delist announcements found
⏳ Waiting 300 seconds before next check...
```

## 🔧 Troubleshooting

### Common Issues

1. **API Authentication Failed**
   - Check if API keys in `.env.local` file are correct
   - Confirm API keys have sufficient permissions

2. **Network Connection Issues**
   - Check network connection
   - Confirm OKX API is accessible

3. **Missing Python Dependencies**
   - Run `pip install requests python-dotenv`

4. **Permission Issues**
   - Ensure script has execution permissions: `chmod +x start_monitor.sh`

## 💡 Usage Recommendations

- **Long-term Running**: Recommended to run on server or cloud host for 24/7 monitoring
- **Log Recording**: Can be combined with `nohup` or `screen` for background running
- **Multiple Instances**: Can run multiple monitoring instances for improved reliability

## 📝 Update Log

- **v1.0**: Basic monitoring functionality, supports 5-minute interval checks
- **v1.1**: Added system sound alerts
- **v1.2**: Optimized error handling and log output
