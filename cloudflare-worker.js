/**
 * Cloudflare Worker for triggering GitHub Actions
 * Cron triggers: every 5 minutes for monitoring/fill protection and every 15 minutes for auto-sells
 */

// GitHub 配置 - 默认值
const DEFAULT_GITHUB_OWNER = 'xucheng2024';
const DEFAULT_GITHUB_REPO = 'crypto-trading-automation';


export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const scheduledTime = event.scheduledTime || new Date();
    
    // 检查当前时间，用于确定具体触发哪些脚本
    const now = new Date(scheduledTime);
    const minute = now.getUTCMinutes();
    const hour = now.getUTCHours();
    
    // 添加时间戳日志，帮助调试重复执行问题
    const timestamp = now.toISOString();
    console.log(`🕐 Worker triggered at: ${timestamp}`);
    console.log(`🕐 Cron: ${cron}, Hour: ${hour}, Minute: ${minute}`);
    
    // 去重机制：检查同一分钟是否已经执行过
    const runKey = `run:${cron}:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
    
    try {
      // 尝试从KV获取执行记录
      const existingRun = await env.DEDUP_KV?.get(runKey);
      if (existingRun) {
        console.log(`⚠️ Duplicate execution detected for key: ${runKey}`);
        return new Response('Duplicate execution prevented', { status: 200 });
      }
      
      // 标记为已执行（TTL: 1小时）
      await env.DEDUP_KV?.put(runKey, timestamp, { expirationTtl: 3600 });
      console.log(`✅ Marked execution for key: ${runKey}`);
    } catch (error) {
      console.log(`⚠️ Deduplication check failed: ${error.message}, continuing execution`);
    }
    
    // 计算新加坡时间 (UTC+8)
    const sgtTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    
    console.log('=== Cron Triggered ===');
    console.log(`🕐 Cron expression: ${cron}`);
    console.log(`🕐 UTC time: ${now.toISOString()}`);
    console.log(`🕐 SGT time: ${sgtTime.toISOString()}`);
    console.log(`🕐 Trigger details: minute=${minute}, hour=${hour} UTC`);
    
    try {
      // 使用Map精确分流，避免时间判断错误和隐性空转
      const cronMap = new Map([
        ["1,6,11,16,21,26,31,36,41,46,51,56 * * * *", ['monitor_delist', 'cancel_pending_limits', 'fetch_filled_orders']],
        ["0,15,30,45 * * * *", ['auto_sell_orders']],
        ["55 15 * * *", ['auto_sell_orders', 'cancel_pending_triggers']], // 15:55 UTC = 23:55 SGT
        ["5 16 * * *", ['create_algo_triggers']],     // 16:05 UTC = 00:05 SGT
        ["10 16 * * *", ['fetch_filled_orders']],     // 16:10 UTC = 00:10 SGT daily DB fallback
      ]);
      
      const scripts = cronMap.get(event.cron);
      if (!scripts) {
        console.log(`⚠️ No scripts mapped for cron: ${event.cron}`);
        return new Response('No scripts mapped', { status: 200 });
      }
      
      // 根据脚本类型输出日志
      if (scripts.includes('monitor_delist')) {
        console.log('📅 5-minute interval (staggered): monitor_delist + cancel_pending_limits + fetch_filled_orders');
      } else if (cron === "10 16 * * *") {
        console.log('🛡️ Daily fallback (UTC 16:10 = SGT 00:10): force DB-backed fetch_filled_orders');
      } else if (scripts.includes('fetch_filled_orders')) {
        console.log('📅 fetch_filled_orders trigger protection check');
      } else if (scripts.includes('auto_sell_orders')) {
        console.log('🌙 Nightly (UTC 15:55 = SGT 23:55): auto_sell_orders + cancel_pending_triggers');
      } else if (scripts.includes('create_algo_triggers')) {
        console.log('🌅 Morning (UTC 16:05 = SGT 00:05): create_algo_triggers');
      }

      const forceDbFetch = cron === "10 16 * * *";
      const verifyDailyClose = cron === "55 15 * * *";
      
      // 触发 GitHub repository_dispatch
      const githubOwner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
      const githubRepo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
      const response = await fetch(`https://api.github.com/repos/${githubOwner}/${githubRepo}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Cloudflare-Worker-Cron'
        },
        body: JSON.stringify({
          event_type: 'cron',
          client_payload: {
            timestamp: new Date().toISOString(),
            source: 'cloudflare-worker',
            cron_schedule: cron,
            scripts: scripts,
            force_db_fetch: forceDbFetch,
            verify_daily_close: verifyDailyClose,
            interval: event.cron === "1,6,11,16,21,26,31,36,41,46,51,56 * * * *" ? '5min' : 
                      event.cron === "0,15,30,45 * * * *" ? '15min' : 
                      (event.cron === "55 15 * * *" || event.cron === "5 16 * * *" || event.cron === "10 16 * * *") ? 'daily' : 'other'
          }
        })
      });

      console.log(`📤 GitHub API request sent for scripts: ${scripts.join(', ')}`);
      console.log(`📤 GitHub API response status: ${response.status}`);
      
      if (response.ok) {
        const responseText = await response.text();
        console.log(`✅ GitHub Actions triggered successfully for: ${scripts.join(', ')}`);
        console.log(`✅ GitHub API response: ${responseText || 'No response body'}`);
        return new Response('OK', { status: 200 });
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed to trigger GitHub Actions: ${response.status} - ${errorText}`);
        return new Response(`Error: ${response.status}`, { status: response.status });
      }
    } catch (error) {
      console.error('❌ Error triggering GitHub Actions:', error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },

  // 手动测试接口
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      // 手动触发
      return this.scheduled({ cron: 'manual' }, env, ctx);
    }
    
    const githubOwner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
    const githubRepo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
    
    return new Response(`
      <h1>🚀 Crypto Trading Automation Cron Worker</h1>
      <p>Status: Active</p>
      <p>GitHub Repo: ${githubOwner}/${githubRepo}</p>
      <p>POST to this endpoint to manually trigger</p>
      <hr>
      <h2>📅 Cron Schedule:</h2>
      <ul>
        <li><strong>每5分钟 (1,6,11,16,21,26,31,36,41,46,51,56 * * * *)</strong>: monitor_delist.py + cancel_pending_limits.py + fetch_filled_orders.py</li>
        <li><strong>每15分钟 (0,15,30,45 * * * *)</strong>: auto_sell_orders.py</li>
        <li><strong>每天15:55 UTC = 23:55 SGT (55 15 * * *)</strong>: auto_sell_orders.py + cancel_pending_triggers.py</li>
        <li><strong>每天16:05 UTC = 00:05 SGT (5 16 * * *)</strong>: create_algo_triggers.py</li>
        <li><strong>每天16:10 UTC = 00:10 SGT (10 16 * * *)</strong>: fetch_filled_orders.py (force DB fallback)</li>
      </ul>
      <hr>
      <h2>🔧 执行逻辑:</h2>
      <ul>
        <li>5分钟间隔: 监控、成交同步、trigger 保护和取消限价单</li>
        <li>15分钟间隔: 重试卖出到期订单</li>
        <li>夜间任务: 23:55 SGT 强制执行自动卖出 + 取消待处理触发器</li>
        <li>早晨任务: 创建算法触发器</li>
        <li>每日托底: 00:10 SGT 强制执行一次 DB-backed fetch，修正空闲期漏同步风险</li>
      </ul>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
};
