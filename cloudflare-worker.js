/**
 * Cloudflare Worker for triggering GitHub Actions
 * Cron triggers: 每5分钟和每15分钟执行不同脚本组合
 */

// GitHub 配置
const GITHUB_OWNER = 'xucheng2024';
const GITHUB_REPO = 'crypto-trading-automation';
const GITHUB_TOKEN = 'YOUR_GITHUB_TOKEN'; // 需要设置环境变量

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const scheduledTime = event.scheduledTime || new Date();
    
    // 检查当前时间，用于确定具体触发哪些脚本
    const now = new Date(scheduledTime);
    const minute = now.getUTCMinutes();
    const hour = now.getUTCHours();
    
    // 计算新加坡时间 (UTC+8)
    const sgtTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    
    console.log('=== Cron Triggered ===');
    console.log(`🕐 Cron expression: ${cron}`);
    console.log(`🕐 UTC time: ${now.toISOString()}`);
    console.log(`🕐 SGT time: ${sgtTime.toISOString()}`);
    console.log(`🕐 Trigger details: minute=${minute}, hour=${hour} UTC`);
    
    try {
      // 根据cron频率决定触发哪些脚本
      let scripts = [];
      
      // 判断是否是7分钟间隔的触发 (2, 9, 16, 23, 37, 44, 51, 58) - 错开整点避免冲突
      if ([2, 9, 16, 23, 37, 44, 51, 58].includes(minute)) {
        scripts = ['monitor_delist', 'cancel_pending_limits'];
        console.log('📅 7-minute interval (staggered): monitor_delist + cancel_pending_limits');
      }
      // 判断是否是15分钟间隔的触发 (0, 15, 45) - 移除30分钟避免与7分钟冲突
      else if ([0, 15, 45].includes(minute)) {
        scripts = ['fetch_filled_orders', 'auto_sell_orders'];
        console.log('📅 15-minute interval: fetch_filled_orders + auto_sell_orders');
      }
      // 每天15:55 UTC (23:55 SGT): 取消待处理触发器
      else if (hour === 15 && minute === 55) {
        scripts = ['cancel_pending_triggers'];
        console.log('🌙 Nightly (SGT 23:55): cancel_pending_triggers');
      }
      // 每天16:05 UTC (00:05 SGT): 创建算法触发器
      else if (hour === 16 && minute === 5) {
        scripts = ['create_algo_triggers'];
        console.log('🌅 Morning (SGT 00:05): create_algo_triggers');
      }
      else {
        console.log(`⚠️ No scripts matched for cron: ${cron}, time: ${hour}:${minute}`);
        return new Response('No scripts to run', { status: 200 });
      }
      
      // 触发 GitHub repository_dispatch
      const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN || GITHUB_TOKEN}`,
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
            interval: (minute % 7 === 0 && minute % 15 !== 0) ? '7min' : (minute % 15 === 0) ? '15min' : ((hour === 15 && minute === 55) || (hour === 16 && minute === 5)) ? 'daily' : 'other'
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
    
    return new Response(`
      <h1>🚀 Crypto Trading Automation Cron Worker</h1>
      <p>Status: Active</p>
      <p>GitHub Repo: ${GITHUB_OWNER}/${GITHUB_REPO}</p>
      <p>POST to this endpoint to manually trigger</p>
      <hr>
      <h2>📅 Cron Schedule:</h2>
      <ul>
        <li><strong>每7分钟 (2,9,16,23,37,44,51,58 * * * *)</strong>: monitor_delist.py + cancel_pending_limits.py</li>
        <li><strong>每15分钟 (0,15,45 * * * *)</strong>: fetch_filled_orders.py + auto_sell_orders.py</li>
        <li><strong>每天23:55 SGT (55 15 * * * UTC)</strong>: cancel_pending_triggers.py</li>
        <li><strong>每天00:05 SGT (5 16 * * * UTC)</strong>: create_algo_triggers.py</li>
      </ul>
      <hr>
      <h2>🔧 执行逻辑:</h2>
      <ul>
        <li>7分钟间隔: 监控和保护 + 取消限价单</li>
        <li>15分钟间隔: 获取已完成订单 + 自动卖出</li>
        <li>夜间任务: 取消待处理触发器</li>
        <li>早晨任务: 创建算法触发器</li>
      </ul>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
};
